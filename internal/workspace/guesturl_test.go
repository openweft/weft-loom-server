package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestEnsureGuestCredentialErrorsAndRevocation(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "fake-qemu")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEFT_LOOM_WORKSPACE_DIR", t.TempDir())
	id := Identity{Subject: "alice"}

	p := &QEMUProvisioner{NATSURL: "nats://127.0.0.1:1", QEMUBinary: bin}
	p.GuestAuth = func(string) (string, string, func(), error) { return "", "", nil, errors.New("boom") }
	if _, err := p.Ensure(context.Background(), id); err == nil || !strings.Contains(err.Error(), "guest nats credential") {
		t.Fatalf("err = %v", err)
	}

	// The broker is unreachable: the credential just issued is revoked.
	revoked := 0
	p.GuestAuth = func(string) (string, string, func(), error) { return "u", "p", func() { revoked++ }, nil }
	if _, err := p.Ensure(context.Background(), id); err == nil || !strings.Contains(err.Error(), "nats connect") {
		t.Fatalf("err = %v", err)
	}
	if revoked != 1 {
		t.Fatalf("credential revoked %d times after a failed Ensure, want 1", revoked)
	}
}
