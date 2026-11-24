package natsbroker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"
)

// externalBroker starts a server configured like weft-nats (an auth
// callout, no anonymous user) and returns its URL plus loom-server's user
// seed and the callout seed.
func externalBroker(t *testing.T) (url, loomSeed, calloutSeed string) {
	t.Helper()
	us, _ := nkeys.CreateUser()
	as, _ := nkeys.CreateAccount()
	useed, _ := us.Seed()
	aseed, _ := as.Seed()
	upub, _ := us.PublicKey()
	apub, _ := as.PublicKey()
	dir := t.TempDir()
	conf := filepath.Join(dir, "nats.conf")
	text := fmt.Sprintf(`
listen: 127.0.0.1:-1
jetstream { store_dir: %q }
accounts { WEFT { jetstream: enabled, users: [ {nkey: %s} ] } }
authorization { auth_callout { issuer: %s, auth_users: [ %s ], account: WEFT } }
`, filepath.Join(dir, "js"), upub, apub, upub)
	if err := os.WriteFile(conf, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	opts, err := server.ProcessConfigFile(conf)
	if err != nil {
		t.Fatal(err)
	}
	opts.NoSigs = true
	srv, err := server.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(5 * time.Second) {
		t.Fatal("broker not ready")
	}
	t.Cleanup(srv.Shutdown)
	return srv.ClientURL(), string(useed), string(aseed)
}

func TestCalloutExternalBroker(t *testing.T) {
	url, loomSeed, calloutSeed := externalBroker(t)
	t.Setenv(EnvSeed, loomSeed)
	proveCallout(t, url, calloutSeed)
}

// TestCalloutLiveBroker runs the same checks against a running weft-nats
// container: WEFT_NATS_E2E_URL, and files holding the two seeds.
func TestCalloutLiveBroker(t *testing.T) {
	url := os.Getenv("WEFT_NATS_E2E_URL")
	if url == "" {
		t.Skip("WEFT_NATS_E2E_URL not set")
	}
	read := func(env string) string {
		b, err := os.ReadFile(os.Getenv(env))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	t.Setenv(EnvSeed, read("WEFT_NATS_E2E_LOOM_SEED_FILE"))
	proveCallout(t, url, read("WEFT_NATS_E2E_CALLOUT_SEED_FILE"))
}

func proveCallout(t *testing.T, url, calloutSeed string) {
	t.Helper()

	// 1. An anonymous client is refused.
	if nc, err := nats.Connect(url, nats.Timeout(2*time.Second)); err == nil {
		nc.Close()
		t.Fatal("anonymous client was accepted")
	}

	co, err := StartCallout(url, calloutSeed, "")
	if err != nil {
		t.Fatal(err)
	}
	defer co.Close()

	// An unknown VM credential is refused.
	if nc, err := nats.Connect(url, nats.UserInfo("vm-nobody", "x"), nats.Timeout(2*time.Second)); err == nil {
		nc.Close()
		t.Fatal("unknown guest was accepted")
	}

	userA, passA, err := co.AddGuest("vmA")
	if err != nil {
		t.Fatal(err)
	}
	if nc, err := nats.Connect(url, nats.UserInfo(userA, "wrong"), nats.Timeout(2*time.Second)); err == nil {
		nc.Close()
		t.Fatal("wrong guest password was accepted")
	}

	violations := make(chan string, 8)
	guest, err := nats.Connect(url, nats.UserInfo(userA, passA), nats.Timeout(2*time.Second),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, e error) { violations <- e.Error() }))
	if err != nil {
		t.Fatalf("guest A refused: %v", err)
	}
	defer guest.Close()

	// 2. A per-VM credential cannot subscribe to another VM's subject.
	own, err := guest.SubscribeSync("weft.mounts.vmA")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := guest.SubscribeSync("weft.mounts.vmB"); err != nil {
		t.Fatal(err) // the refusal is asynchronous
	}
	_ = guest.Flush()
	select {
	case v := <-violations:
		if !strings.Contains(v, "Permissions Violation") {
			t.Fatalf("unexpected error %q", v)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("guest A subscribed to weft.mounts.vmB")
	}
	if _, err := guest.SubscribeSync("weft.mounts.>"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-violations:
	case <-time.After(3 * time.Second):
		t.Fatal("guest A subscribed to weft.mounts.>")
	}

	// 3. loom-server can still publish; the guest sees its own subject.
	loom, err := nats.Connect(url, ClientOptions()...)
	if err != nil {
		t.Fatalf("loom-server refused: %v", err)
	}
	defer loom.Close()
	js, _ := loom.JetStream()
	if _, err := js.StreamInfo("weft-mounts"); err != nil {
		t.Fatalf("stream weft-mounts not created: %v", err)
	}
	if err := loom.Publish("weft.mounts.vmA", []byte("secret-for-A")); err != nil {
		t.Fatal(err)
	}
	if err := loom.Publish("weft.mounts.vmB", []byte("secret-for-B")); err != nil {
		t.Fatal(err)
	}
	_ = loom.Flush()
	m, err := own.NextMsg(3 * time.Second)
	if err != nil || string(m.Data) != "secret-for-A" {
		t.Fatalf("guest A got %v, %v", m, err)
	}

	// Revoked: no new connection.
	co.RemoveGuest("vmA")
	if nc, err := nats.Connect(url, nats.UserInfo(userA, passA), nats.Timeout(2*time.Second)); err == nil {
		nc.Close()
		t.Fatal("revoked guest was accepted")
	}
}

func TestStartCalloutRejectsBadSeeds(t *testing.T) {
	if _, err := StartCallout("nats://127.0.0.1:1", "garbage", ""); err == nil {
		t.Fatal("garbage seed accepted")
	}
	us, _ := nkeys.CreateUser()
	seed, _ := us.Seed()
	if _, err := StartCallout("nats://127.0.0.1:1", string(seed), ""); err == nil {
		t.Fatal("user seed accepted as a callout seed")
	}
}

func TestCalloutGuestIDValidation(t *testing.T) {
	c := &Callout{guests: map[string]guest{}}
	if _, _, err := c.AddGuest("../x"); err == nil {
		t.Fatal("invalid vm id accepted")
	}
}
