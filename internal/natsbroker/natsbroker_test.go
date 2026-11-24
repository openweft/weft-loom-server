package natsbroker

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"
)

func newSeed(t *testing.T) string {
	t.Helper()
	kp, err := nkeys.CreateUser()
	if err != nil {
		t.Fatal(err)
	}
	s, err := kp.Seed()
	if err != nil {
		t.Fatal(err)
	}
	return string(s)
}

func start(t *testing.T, o Options) *Embedded {
	t.Helper()
	if o.Port == 0 {
		o.Port = -1
	}
	if o.StoreDir == "" {
		o.StoreDir = filepath.Join(t.TempDir(), "nats")
	}
	e, err := Start(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Shutdown)
	return e
}

func loomConn(t *testing.T, e *Embedded, seed string) *nats.Conn {
	t.Helper()
	kp, _ := nkeys.FromSeed([]byte(seed))
	pub, _ := kp.PublicKey()
	nc, err := nats.Connect(e.URL, nats.Nkey(pub, func(n []byte) ([]byte, error) { return kp.Sign(n) }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	return nc
}

func TestStartRefusesWithoutAuth(t *testing.T) {
	t.Setenv(EnvAllowNoAuth, "")
	_, err := Start(Options{Port: -1, StoreDir: filepath.Join(t.TempDir(), "n")})
	if !errors.Is(err, ErrNoAuth) {
		t.Fatalf("err = %v, want ErrNoAuth", err)
	}
}

func TestStartRejectsBadSeed(t *testing.T) {
	_, err := Start(Options{Port: -1, StoreDir: filepath.Join(t.TempDir(), "n"), NkeySeed: "nope"})
	if err == nil || !strings.Contains(err.Error(), "valid nkey seed") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "nope") {
		t.Fatal("error leaks the seed")
	}
	acct, _ := nkeys.CreateAccount()
	s, _ := acct.Seed()
	if _, err := Start(Options{Port: -1, StoreDir: filepath.Join(t.TempDir(), "n"), NkeySeed: string(s)}); err == nil {
		t.Fatal("an account seed was accepted")
	}
}

func TestDevFlagStartsOpen(t *testing.T) {
	t.Setenv(EnvAllowNoAuth, "1")
	e := start(t, Options{})
	if !e.Open {
		t.Fatal("broker not flagged open")
	}
	nc, err := nats.Connect(e.URL)
	if err != nil {
		t.Fatal(err)
	}
	nc.Close()
}

func TestAnonymousAndWrongCredentialsRefused(t *testing.T) {
	seed := newSeed(t)
	e := start(t, Options{NkeySeed: seed})
	if _, err := nats.Connect(e.URL); err == nil {
		t.Fatal("anonymous connection accepted")
	}
	if _, err := nats.Connect(e.URL, nats.UserInfo("vm-x", "guess")); err == nil {
		t.Fatal("unknown user accepted")
	}
	user, _, err := e.AddGuest("vmaaa")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := nats.Connect(e.URL, nats.UserInfo(user, "wrong")); err == nil {
		t.Fatal("wrong password accepted")
	}
	// An nkey that is not loom-server's.
	other, _ := nkeys.CreateUser()
	pub, _ := other.PublicKey()
	if _, err := nats.Connect(e.URL, nats.Nkey(pub, func(n []byte) ([]byte, error) { return other.Sign(n) })); err == nil {
		t.Fatal("foreign nkey accepted")
	}
	loomConn(t, e, seed) // the real one works
}

func TestGuestOnlySeesItsOwnMounts(t *testing.T) {
	seed := newSeed(t)
	e := start(t, Options{NkeySeed: seed})
	loom := loomConn(t, e, seed)

	userA, passA, err := e.AddGuest("vmaaa")
	if err != nil {
		t.Fatal(err)
	}
	asyncErr := make(chan error, 8)
	a, err := nats.Connect(e.URL, nats.UserInfo(userA, passA),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) { asyncErr <- err }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)

	own := make(chan *nats.Msg, 4)
	if _, err := a.ChanSubscribe("weft.mounts.vmaaa", own); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Subscribe("weft.mounts.vmbbb", func(*nats.Msg) { t.Error("received another VM's message") }); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Subscribe("weft.mounts.>", func(*nats.Msg) { t.Error("wildcard delivered") }); err != nil {
		t.Fatal(err)
	}
	_ = a.Flush()

	if err := loom.Publish("weft.mounts.vmbbb", []byte("secret-b")); err != nil {
		t.Fatal(err)
	}
	if err := loom.Publish("weft.mounts.vmaaa", []byte("for-a")); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-own:
		if string(m.Data) != "for-a" {
			t.Fatalf("got %q", m.Data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("own subject message not delivered")
	}
	// The two denied subscriptions were reported as permission violations.
	denied := 0
	deadline := time.After(2 * time.Second)
	for denied < 2 {
		select {
		case err := <-asyncErr:
			if strings.Contains(strings.ToLower(err.Error()), "permissions violation") {
				denied++
			}
		case <-deadline:
			t.Fatalf("only %d permission violations reported", denied)
		}
	}

	// A guest cannot publish on another VM's subjects nor on the mounts.
	if err := a.Publish("weft.mounts.vmbbb", []byte("x")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-asyncErr:
		if !strings.Contains(strings.ToLower(err.Error()), "permissions violation") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("publish on another VM's subject was not refused")
	}
}

func TestGuestJetStreamIsScopedToItsSubject(t *testing.T) {
	seed := newSeed(t)
	e := start(t, Options{NkeySeed: seed})
	loom := loomConn(t, e, seed)
	js, err := loom.JetStream()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish("weft.mounts.vmaaa", []byte("a-key")); err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish("weft.mounts.vmbbb", []byte("b-key")); err != nil {
		t.Fatal(err)
	}

	user, pass, _ := e.AddGuest("vmaaa")
	g, err := nats.Connect(e.URL, nats.UserInfo(user, pass))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Close)
	gjs, err := g.JetStream()
	if err != nil {
		t.Fatal(err)
	}
	sub, err := gjs.SubscribeSync("weft.mounts.vmaaa", nats.BindStream("weft-mounts"), nats.DeliverLastPerSubject())
	if err != nil {
		t.Fatalf("own replay refused: %v", err)
	}
	m, err := sub.NextMsg(3 * time.Second)
	if err != nil || string(m.Data) != "a-key" {
		t.Fatalf("replay = %v %v", m, err)
	}
	if _, err := gjs.SubscribeSync("weft.mounts.vmbbb", nats.BindStream("weft-mounts")); err == nil {
		t.Fatal("a guest created a consumer on another VM's subject")
	}
	if _, err := gjs.SubscribeSync("weft.mounts.*", nats.BindStream("weft-mounts")); err == nil {
		t.Fatal("a guest created a wildcard consumer")
	}
}

func TestRemoveGuestRevokes(t *testing.T) {
	e := start(t, Options{NkeySeed: newSeed(t)})
	user, pass, _ := e.AddGuest("vmaaa")
	e.RemoveGuest("vmaaa")
	if _, err := nats.Connect(e.URL, nats.UserInfo(user, pass)); err == nil {
		t.Fatal("revoked guest connected")
	}
}

func TestAddGuestRejectsWildcardIDs(t *testing.T) {
	e := start(t, Options{NkeySeed: newSeed(t)})
	for _, id := range []string{"", "a.b", "a*", ">", "a b", "a>"} {
		if _, _, err := e.AddGuest(id); err == nil {
			t.Errorf("vm id %q accepted", id)
		}
	}
}

func TestStoreDirIsPrivateAndNotTmp(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state", "nats")
	if err := os.MkdirAll(dir, 0o755); err != nil { // pre-existing and too open
		t.Fatal(err)
	}
	start(t, Options{NkeySeed: newSeed(t), StoreDir: dir})
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o700 {
		t.Fatalf("store dir mode = %o, want 700", got)
	}

	t.Setenv(EnvStoreDir, "")
	t.Setenv("STATE_DIRECTORY", "/var/lib/weft-loom:/other")
	d, err := DefaultStoreDir()
	if err != nil || d != "/var/lib/weft-loom/nats" {
		t.Fatalf("DefaultStoreDir = %q, %v", d, err)
	}
	t.Setenv("STATE_DIRECTORY", "")
	d, err = DefaultStoreDir()
	if err != nil {
		t.Skip("no user cache dir")
	}
	if strings.HasPrefix(d, "/tmp") {
		t.Fatalf("default store dir under /tmp: %s", d)
	}
}

func TestGuestURL(t *testing.T) {
	got, err := GuestURL("nats://10.0.2.2:4222", "vm-a", "p+/w")
	if err != nil || got != "nats://vm-a:p+%2Fw@10.0.2.2:4222" {
		t.Fatalf("GuestURL = %q, %v", got, err)
	}
	if got, _ := GuestURL("nats://h:1", "", ""); got != "nats://h:1" {
		t.Fatalf("open broker URL changed: %q", got)
	}
}
