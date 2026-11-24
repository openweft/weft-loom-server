package secretenv

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

const sentinel = "s3cr3t-VALUE-do-not-echo"

func stub(t *testing.T, fn func(string) ([]byte, error)) {
	t.Helper()
	old := open
	open = func(_ context.Context, ref string) ([]byte, error) { return fn(ref) }
	t.Cleanup(func() { open = old; reset() })
	reset()
}

func TestPlaintextWorksWarnsAndIsUnset(t *testing.T) {
	stub(t, nil)
	t.Setenv("X_KEY", sentinel)
	var w bytes.Buffer
	if err := Resolve(context.Background(), &w, "X_KEY"); err != nil {
		t.Fatal(err)
	}
	if got := Get("X_KEY"); got != sentinel {
		t.Fatalf("Get = %q", got)
	}
	if _, set := os.LookupEnv("X_KEY"); set {
		t.Fatal("plaintext variable still in the environment")
	}
	if !strings.Contains(w.String(), "X_KEY_FROM") || strings.Contains(w.String(), sentinel) {
		t.Fatalf("warning = %q", w.String())
	}
}

func TestFromResolvesAndTrimsNewline(t *testing.T) {
	stub(t, func(ref string) ([]byte, error) {
		if ref != "file:/x" {
			t.Fatalf("ref = %q", ref)
		}
		return []byte(sentinel + "\n"), nil
	})
	t.Setenv("X_KEY_FROM", "file:/x")
	var w bytes.Buffer
	if err := Resolve(context.Background(), &w, "X_KEY"); err != nil {
		t.Fatal(err)
	}
	if Get("X_KEY") != sentinel {
		t.Fatalf("Get = %q", Get("X_KEY"))
	}
	if w.Len() != 0 {
		t.Fatalf("unexpected warning %q", w.String())
	}
}

func TestBothSetIsAnError(t *testing.T) {
	stub(t, nil)
	t.Setenv("X_KEY", sentinel)
	t.Setenv("X_KEY_FROM", "file:/x")
	err := Resolve(context.Background(), nil, "X_KEY")
	if err == nil || strings.Contains(err.Error(), sentinel) {
		t.Fatalf("err = %v", err)
	}
}

func TestUnresolvableRefNeverEchoesTheValue(t *testing.T) {
	stub(t, func(string) ([]byte, error) { return nil, errors.New("no such credential") })
	t.Setenv("X_KEY_FROM", "systemd-creds:"+sentinel)
	err := Resolve(context.Background(), nil, "X_KEY")
	if err == nil || !strings.Contains(err.Error(), "X_KEY_FROM") {
		t.Fatalf("err = %v", err)
	}
}

func TestEmptySecretIsAnError(t *testing.T) {
	stub(t, func(string) ([]byte, error) { return []byte("\n"), nil })
	t.Setenv("X_KEY_FROM", "file:/x")
	if err := Resolve(context.Background(), nil, "X_KEY"); err == nil {
		t.Fatal("empty secret accepted")
	}
}

func TestUnsetStaysEmptyAndGetFallsBackToEnv(t *testing.T) {
	stub(t, nil)
	if err := Resolve(context.Background(), nil, "X_KEY"); err != nil {
		t.Fatal(err)
	}
	if Get("X_KEY") != "" {
		t.Fatal("expected empty")
	}
	t.Setenv("Y_KEY", "from-env")
	if Get("Y_KEY") != "from-env" {
		t.Fatal("no env fallback")
	}
}
