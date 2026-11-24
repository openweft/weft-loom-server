package workspace

import (
	"errors"
	"testing"
)

func TestGuestURLFor(t *testing.T) {
	p := &QEMUProvisioner{}
	u, rev, err := p.guestURLFor("nats://10.0.2.2:4222", "vm1")
	if err != nil || u != "nats://10.0.2.2:4222" {
		t.Fatalf("no auth: %q %v", u, err)
	}
	rev()

	revoked := 0
	p.GuestAuth = func(id string) (string, string, func(), error) {
		return "vm-" + id, "pw", func() { revoked++ }, nil
	}
	u, rev, err = p.guestURLFor("nats://10.0.2.2:4222", "vm1")
	if err != nil || u != "nats://vm-vm1:pw@10.0.2.2:4222" {
		t.Fatalf("auth: %q %v", u, err)
	}
	rev()
	if revoked != 1 {
		t.Fatalf("revoked = %d", revoked)
	}

	// A bad base URL is an error and revokes the credential just issued.
	if _, _, err = p.guestURLFor("nats://bad host:4222%zz", "vm1"); err == nil {
		t.Fatal("bad URL accepted")
	}
	if revoked != 2 {
		t.Fatalf("credential not revoked on URL error: %d", revoked)
	}

	p.GuestAuth = func(string) (string, string, func(), error) { return "", "", nil, errors.New("boom") }
	if _, _, err = p.guestURLFor("nats://h:1", "vm1"); err == nil {
		t.Fatal("credential error swallowed")
	}

	// A nil revoke func is tolerated.
	p.GuestAuth = func(string) (string, string, func(), error) { return "u", "p", nil, nil }
	if _, rev, err = p.guestURLFor("nats://h:1", "vm1"); err != nil {
		t.Fatal(err)
	} else {
		rev()
	}
}
