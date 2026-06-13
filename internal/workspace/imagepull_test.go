package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestImagePuller_LocalPath verifies the puller passes a local path
// through without touching the network — critical for the dev mode
// where operators point WEFT_WORKSPACE_BASE_QCOW2 at a hand-baked
// qcow2 instead of an OCI ref.
func TestImagePuller_LocalPath(t *testing.T) {
	tmp := t.TempDir()
	base := filepath.Join(tmp, "base.qcow2")
	if err := os.WriteFile(base, []byte("qcow2-magic"), 0o644); err != nil {
		t.Fatalf("seed base: %v", err)
	}
	p := NewImagePuller(filepath.Join(tmp, "cache"))
	got, err := p.ResolveBaseQcow2(context.Background(), base)
	if err != nil {
		t.Fatalf("ResolveBaseQcow2: %v", err)
	}
	if got != base {
		t.Fatalf("got %q, want %q", got, base)
	}
}

// TestImagePuller_LocalPathMissing surfaces a clear error when the
// configured path doesn't exist — operators would otherwise see a
// cryptic qemu-img failure later in the boot sequence.
func TestImagePuller_LocalPathMissing(t *testing.T) {
	tmp := t.TempDir()
	missing := filepath.Join(tmp, "does-not-exist.qcow2")
	p := NewImagePuller(filepath.Join(tmp, "cache"))
	_, err := p.ResolveBaseQcow2(context.Background(), missing)
	if err == nil {
		t.Fatal("expected error for missing local path")
	}
}

// TestImagePuller_EmptyRef rejects the no-config case rather than
// silently picking a stub path.
func TestImagePuller_EmptyRef(t *testing.T) {
	p := NewImagePuller(t.TempDir())
	_, err := p.ResolveBaseQcow2(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty ref")
	}
}

// TestIsLocalPath_Heuristic locks in the disambiguation rules so a
// future "smart" parser doesn't regress dev workflows (relative
// paths, absolute paths, etc).
func TestIsLocalPath_Heuristic(t *testing.T) {
	for _, c := range []struct {
		name string
		in   string
		want bool
	}{
		{"absolute", "/tmp/x.qcow2", true},
		{"dot-rel", "./x.qcow2", true},
		{"dot-dot-rel", "../x.qcow2", true},
		{"plain-name", "x.qcow2", true},
		{"ghcr-with-tag", "ghcr.io/openweft/weft-loom-workspace-base:v0.1.0", false},
		{"docker-hub", "docker.io/library/alpine:3.20", false},
		{"localhost-registry", "localhost:5000/foo:bar", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := isLocalPath(c.in); got != c.want {
				t.Errorf("isLocalPath(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
