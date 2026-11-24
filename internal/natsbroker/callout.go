package natsbroker

// Per-VM credentials on an EXTERNAL broker (the weft-nats image).
//
// The external broker is configured with an auth callout (see
// github.com/openweft/weft-nats): it holds no secret, only the PUBLIC
// keys of loom-server's user nkey (an auth user, bypasses the callout)
// and of the callout signing key. Every other connection, anonymous ones
// included, is sent to this service, which answers only for a VM
// credential minted by [Callout.AddGuest] and signs a user JWT limited to
// [GuestPermissions]. Anything else is refused. Revocation matches the
// embedded broker: RemoveGuest stops new connections.

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/nats-io/jwt/v2"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"

	"github.com/openweft/weft-loom-server/internal/secretenv"
)

// EnvCalloutSeed is the account nkey seed (SA...) that signs the user
// JWTs answered to the broker; by reference as
// WEFT_LOOM_NATS_CALLOUT_SEED_FROM. Its public key is the broker's
// auth_callout issuer.
const EnvCalloutSeed = "WEFT_LOOM_NATS_CALLOUT_SEED"

// EnvCalloutAccount names the broker account the guests are placed in
// (default [DefaultCalloutAccount]).
const EnvCalloutAccount = "WEFT_LOOM_NATS_CALLOUT_ACCOUNT"

// DefaultCalloutAccount matches the account of weft-nats' config.
const DefaultCalloutAccount = "WEFT"

// calloutSubject is where the server sends authorization requests.
const calloutSubject = "$SYS.REQ.USER.AUTH"

// CalloutSeedFromEnv returns the callout signing seed ("" when unset).
func CalloutSeedFromEnv() string { return secretenv.Get(EnvCalloutSeed) }

// Callout answers the external broker's authorization requests.
type Callout struct {
	nc      *nats.Conn
	sub     *nats.Subscription
	issuer  nkeys.KeyPair
	account string

	mu     sync.RWMutex
	guests map[string]guest
}

// StartCallout connects with loom-server's nkey (ClientOptions) and serves
// the callout. seed is the account signing seed; account the broker
// account guests join ("" = env or [DefaultCalloutAccount]).
func StartCallout(url, seed, account string) (*Callout, error) {
	kp, err := nkeys.FromSeed([]byte(seed))
	pub := ""
	if err == nil {
		pub, _ = kp.PublicKey()
	}
	if !nkeys.IsValidPublicAccountKey(pub) {
		return nil, errors.New("nats callout: " + EnvCalloutSeed + " must be an nkey account seed (SA...)")
	}
	if account == "" {
		account = os.Getenv(EnvCalloutAccount)
	}
	if account == "" {
		account = DefaultCalloutAccount
	}
	c := &Callout{issuer: kp, account: account, guests: map[string]guest{}}
	nc, err := nats.Connect(url, ClientOptions()...)
	if err != nil {
		return nil, fmt.Errorf("nats callout: connect: %w", err)
	}
	c.nc = nc
	// The streams must exist before a guest asks for a consumer: it has no
	// right to create one.
	if err := createStreams(nc); err != nil {
		nc.Close()
		return nil, fmt.Errorf("nats callout: %w", err)
	}
	// Subscribe fails only on a closed connection, which we just made.
	c.sub, _ = nc.Subscribe(calloutSubject, c.handle)
	_ = nc.Flush()
	return c, nil
}

// handle answers one request.
func (c *Callout) handle(m *nats.Msg) {
	if tok, ok := c.answer(m.Data); ok {
		_ = m.Respond([]byte(tok))
	}
}

// answer returns the signed response to one authorization request, or
// false when the payload is not a request (no answer at all).
func (c *Callout) answer(data []byte) (string, bool) {
	req, err := jwt.DecodeAuthorizationRequestClaims(string(data))
	if err != nil || req.UserNkey == "" {
		return "", false
	}
	co := req.ConnectOptions
	userJWT, errMsg := "", "unauthorized"
	if g, ok := c.lookup(co.Username, co.Password); ok {
		uc := jwt.NewUserClaims(req.UserNkey)
		uc.Audience = c.account
		uc.Permissions = jwtPermissions(g.perm.Publish.Allow, g.perm.Subscribe.Allow)
		userJWT, _ = uc.Encode(c.issuer) // fails only for a non-account key, refused at start
		errMsg = ""
	}
	rsp := jwt.NewAuthorizationResponseClaims(req.UserNkey)
	rsp.Audience = req.Server.ID
	rsp.Jwt = userJWT
	rsp.Error = errMsg
	tok, _ := rsp.Encode(c.issuer)
	return tok, true
}

func jwtPermissions(pub, sub []string) jwt.Permissions {
	var p jwt.Permissions
	p.Pub.Allow.Add(pub...)
	p.Sub.Allow.Add(sub...)
	return p
}

// lookup compares in constant time whether or not the user exists.
func (c *Callout) lookup(user, pass string) (guest, bool) {
	c.mu.RLock()
	g, ok := c.guests[user]
	c.mu.RUnlock()
	want := g.pass
	if !ok {
		want = []byte("-")
	}
	if !ctEqual(pass, want) || !ok {
		return guest{}, false
	}
	return g, true
}

// AddGuest mints the credential of one VM (see [Embedded.AddGuest]).
func (c *Callout) AddGuest(vmID string) (user, pass string, err error) {
	if !vmIDRe.MatchString(vmID) {
		return "", "", fmt.Errorf("nats callout: invalid vm id %q", vmID)
	}
	user, pass = "vm-"+vmID, newPassword()
	c.mu.Lock()
	c.guests[user] = guest{pass: []byte(pass), perm: GuestPermissions(vmID)}
	c.mu.Unlock()
	return user, pass, nil
}

// RemoveGuest revokes a VM's credential for new connections.
func (c *Callout) RemoveGuest(vmID string) {
	c.mu.Lock()
	delete(c.guests, "vm-"+vmID)
	c.mu.Unlock()
}

func ctEqual(a string, b []byte) bool { return subtle.ConstantTimeCompare([]byte(a), b) == 1 }

// newPassword is 128 bits from the system CSPRNG.
func newPassword() string { return rand.Text() }

// Close stops the service.
func (c *Callout) Close() {
	_ = c.sub.Unsubscribe()
	c.nc.Close()
	c.issuer.Wipe()
}
