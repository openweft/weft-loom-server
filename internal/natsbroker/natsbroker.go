// Package natsbroker is the embedded NATS server loom-server boots
// when WEFT_NATS_URL isn't externally provided (single-binary
// deployments; the workspace VM's agent dials back into the host).
//
// The broker always requires authorization:
//
//   - loom-server itself authenticates with an nkey. The seed is given
//     by reference (WEFT_LOOM_NATS_NKEY_SEED_FROM, see internal/secretenv),
//     never inline in a config file.
//   - each workspace VM gets its own generated user/password
//     ([Embedded.AddGuest]) whose permissions cover only that VM's
//     subjects, so a guest cannot read another VM's weft.mounts.<vmID>.
//
// Starting without a seed is refused unless the operator sets
// WEFT_LOOM_NATS_ALLOW_NOAUTH=1 (development only; logged loudly by the
// caller).
//
// JetStream is enabled because the containers + mounts reconcilers rely
// on it (LastPerSubject replay). The store lives in a 0700 state
// directory, never under /tmp.
package natsbroker

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"

	"github.com/openweft/weft-loom-server/internal/secretenv"
)

// Environment variables.
const (
	// EnvSeed is the nkey (user) seed of loom-server, by reference as
	// WEFT_LOOM_NATS_NKEY_SEED_FROM.
	EnvSeed = "WEFT_LOOM_NATS_NKEY_SEED"
	// EnvAllowNoAuth=1 lets the embedded broker start without
	// authorization. Development only.
	EnvAllowNoAuth = "WEFT_LOOM_NATS_ALLOW_NOAUTH"
	// EnvStoreDir overrides the JetStream store directory.
	EnvStoreDir = "WEFT_LOOM_NATS_STORE_DIR"
)

// ErrNoAuth is returned by Start when no nkey seed is configured and
// the dev flag is not set.
var ErrNoAuth = errors.New("embedded nats: refusing to start without authorization: set " +
	EnvSeed + "_FROM=<secretsource ref> to an nkey user seed (or, for development only, " + EnvAllowNoAuth + "=1)")

// streams the broker owns; guests may only consume their own subject.
var streams = map[string]string{
	"weft-mounts":     "weft.mounts",
	"weft-containers": "weft.containers",
}

// Options bundles the embed knobs.
type Options struct {
	// Host the broker listens on. Default "127.0.0.1".
	Host string
	// Port. 0 = the NATS default (4222); -1 = random.
	Port int
	// StoreDir is where JetStream persists streams. Empty =
	// [DefaultStoreDir]. Created or tightened to 0700.
	StoreDir string
	// NkeySeed is the loom-server user seed. Empty = read
	// [EnvSeed] through secretenv.
	NkeySeed string
	// AllowNoAuth starts the broker open. Empty seed AND false = refusal.
	// Also true when EnvAllowNoAuth=1.
	AllowNoAuth bool
}

var userCacheDir = os.UserCacheDir // replaced by tests

// DefaultStoreDir is the state directory used when none is configured:
// $WEFT_LOOM_NATS_STORE_DIR, else the first $STATE_DIRECTORY entry
// (systemd StateDirectory=) + /nats, else <user cache dir>/weft-loom/nats.
// It never points under /tmp.
func DefaultStoreDir() (string, error) {
	if d := os.Getenv(EnvStoreDir); d != "" {
		return d, nil
	}
	if sd := os.Getenv("STATE_DIRECTORY"); sd != "" {
		first, _, _ := strings.Cut(sd, ":")
		return filepath.Join(first, "nats"), nil
	}
	c, err := userCacheDir()
	if err != nil {
		return "", fmt.Errorf("embedded nats: no state directory (set %s): %w", EnvStoreDir, err)
	}
	return filepath.Join(c, "weft-loom", "nats"), nil
}

// Embedded is the running broker.
type Embedded struct {
	srv *server.Server
	URL string
	// Open reports that the broker accepts unauthenticated clients
	// (dev flag).
	Open bool

	loomPub string
	mu      sync.RWMutex
	guests  map[string]guest // user name -> credentials
}

type guest struct {
	pass []byte
	perm *server.Permissions
}

var vmIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Start spins up the broker. Returns when JetStream is ready.
func Start(opts Options) (*Embedded, error) {
	seed := opts.NkeySeed
	if seed == "" {
		seed = secretenv.Get(EnvSeed)
	}
	allowOpen := opts.AllowNoAuth || os.Getenv(EnvAllowNoAuth) == "1"
	e := &Embedded{guests: map[string]guest{}}
	if seed == "" {
		if !allowOpen {
			return nil, ErrNoAuth
		}
		e.Open = true
	} else {
		pub := userPublicKey(seed)
		if pub == "" {
			return nil, errors.New("embedded nats: " + EnvSeed + " is not a valid nkey user seed (SU...)")
		}
		e.loomPub = pub
	}

	if opts.Host == "" {
		opts.Host = "127.0.0.1"
	}
	if opts.StoreDir == "" {
		d, err := DefaultStoreDir()
		if err != nil {
			return nil, err
		}
		opts.StoreDir = d
	}
	if err := ensurePrivateDir(opts.StoreDir); err != nil {
		return nil, err
	}

	srvOpts := &server.Options{
		Host:                  opts.Host,
		Port:                  opts.Port,
		ServerName:            "weft-loom-embedded",
		JetStream:             true,
		StoreDir:              opts.StoreDir,
		DisableShortFirstPing: true,
		NoSigs:                true, // we own signal handling
	}
	if !e.Open {
		srvOpts.AlwaysEnableNonce = true
		srvOpts.CustomClientAuthentication = e
	}
	srv, err := server.NewServer(srvOpts)
	if err != nil {
		return nil, fmt.Errorf("embed nats: %w", err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(5 * time.Second) {
		srv.Shutdown()
		return nil, fmt.Errorf("embed nats: not ready within 5s")
	}
	e.srv = srv
	e.URL = srv.ClientURL()
	if err := e.ensureStreams(seed); err != nil {
		srv.Shutdown()
		return nil, err
	}
	return e, nil
}

// userPublicKey returns the public key of a user seed, "" when seed is
// not a valid user seed.
func userPublicKey(seed string) string {
	pub := ""
	if kp, err := nkeys.FromSeed([]byte(seed)); err == nil {
		pub, _ = kp.PublicKey()
		kp.Wipe()
	}
	if !nkeys.IsValidPublicUserKey(pub) {
		return ""
	}
	return pub
}

// ensurePrivateDir creates dir (0700) or tightens an existing one.
func ensurePrivateDir(dir string) error {
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		err = os.Chmod(dir, 0o700)
	}
	if err != nil {
		return fmt.Errorf("embedded nats: store dir: %w", err)
	}
	return nil
}

// ensureStreams creates the LastPerSubject streams so guests never need
// the right to create one.
func (e *Embedded) ensureStreams(seed string) error {
	nc, err := nats.Connect(e.srv.ClientURL(), clientOptionsFor(seed)...)
	if err != nil {
		return fmt.Errorf("embed nats: stream setup connect: %w", err)
	}
	defer nc.Close()
	return createStreams(nc)
}

// createStreams adds the streams on the broker nc is connected to
// (idempotent).
func createStreams(nc *nats.Conn) error {
	js, _ := nc.JetStream() // errors only on invalid options; none are given
	for name, prefix := range streams {
		_, err := js.AddStream(&nats.StreamConfig{
			Name:              name,
			Subjects:          []string{prefix + ".*"},
			Retention:         nats.LimitsPolicy,
			MaxMsgsPerSubject: 1,
			Storage:           nats.FileStorage,
		})
		if err != nil {
			return fmt.Errorf("embed nats: stream %s: %w", name, err)
		}
	}
	return nil
}

// Check implements server.Authentication.
func (e *Embedded) Check(c server.ClientAuthentication) bool {
	o := c.GetOpts()
	acc := e.srv.GlobalAccount()
	if o.Nkey != "" {
		if subtle.ConstantTimeCompare([]byte(o.Nkey), []byte(e.loomPub)) != 1 {
			return false
		}
		// A malformed signature decodes to bytes that fail Verify.
		sig, _ := base64.RawURLEncoding.DecodeString(o.Sig)
		pk, _ := nkeys.FromPublicKey(o.Nkey) // o.Nkey == e.loomPub, a valid key
		if pk.Verify(c.GetNonce(), sig) != nil {
			return false
		}
		c.RegisterUser(&server.User{Username: "weft-loom", Account: acc})
		return true
	}
	e.mu.RLock()
	g, ok := e.guests[o.Username]
	e.mu.RUnlock()
	// Always compare, so a wrong user name costs the same as a wrong password.
	want := g.pass
	if !ok {
		want = []byte("-")
	}
	if subtle.ConstantTimeCompare([]byte(o.Password), want) != 1 || !ok {
		return false
	}
	c.RegisterUser(&server.User{Username: o.Username, Account: acc, Permissions: g.perm})
	return true
}

// GuestPermissions is the permission set of one VM: its own subjects only.
func GuestPermissions(vmID string) *server.Permissions {
	sub := []string{
		"weft.mounts." + vmID,
		"weft.containers." + vmID,
		"weft.exec." + vmID + ".>",
		"_INBOX.>",
	}
	pub := []string{
		"weft.heartbeat." + vmID,
		"weft.agent." + vmID + ".>",
		"weft.exec." + vmID + ".>",
		"$JS.API.STREAM.INFO.weft-mounts",
		"$JS.API.STREAM.INFO.weft-containers",
		"$JS.ACK.weft-mounts.>",
		"$JS.ACK.weft-containers.>",
	}
	for name, prefix := range streams {
		// A consumer-create subject carries its filter subject: the
		// guest may create consumers only on its own subject.
		pub = append(pub, "$JS.API.CONSUMER.CREATE."+name+".*."+prefix+"."+vmID)
	}
	return &server.Permissions{
		Publish:   &server.SubjectPermission{Allow: pub},
		Subscribe: &server.SubjectPermission{Allow: sub},
	}
}

// AddGuest registers a generated credential for one VM and returns it.
// A second call for the same vmID rotates the password.
func (e *Embedded) AddGuest(vmID string) (user, pass string, err error) {
	if e.Open {
		return "", "", nil
	}
	if !vmIDRe.MatchString(vmID) {
		return "", "", fmt.Errorf("embedded nats: invalid vm id %q", vmID)
	}
	user = "vm-" + vmID
	pass = rand.Text() // 128 bits from the system CSPRNG
	e.mu.Lock()
	e.guests[user] = guest{pass: []byte(pass), perm: GuestPermissions(vmID)}
	e.mu.Unlock()
	return user, pass, nil
}

// RemoveGuest revokes a VM's credential for new connections.
func (e *Embedded) RemoveGuest(vmID string) {
	e.mu.Lock()
	delete(e.guests, "vm-"+vmID)
	e.mu.Unlock()
}

// GuestURL returns base with the VM's credential as userinfo.
func GuestURL(base, user, pass string) (string, error) {
	if user == "" {
		return base, nil
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u.User = url.UserPassword(user, pass)
	return u.String(), nil
}

// ClientOptions returns the nats.Connect options loom-server uses to
// authenticate itself (nkey from [EnvSeed]); none when no seed is set.
func ClientOptions() []nats.Option {
	return clientOptionsFor(secretenv.Get(EnvSeed))
}

func clientOptionsFor(seed string) []nats.Option {
	kp, err := nkeys.FromSeed([]byte(seed))
	if err != nil {
		return nil
	}
	pub, _ := kp.PublicKey()
	return []nats.Option{nats.Nkey(pub, func(nonce []byte) ([]byte, error) { return kp.Sign(nonce) })}
}

// Shutdown stops the broker + drains JetStream. Idempotent.
func (e *Embedded) Shutdown() {
	if e.srv != nil {
		e.srv.Shutdown()
		e.srv.WaitForShutdown()
	}
}
