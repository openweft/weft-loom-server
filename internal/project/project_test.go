package project

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/auth"
)

func TestLocalStore_WriteThenRead(t *testing.T) {
	root := t.TempDir()
	s := NewLocalStore(root)
	ident := auth.Identity{Subject: "alice"}

	if err := s.WriteFile(context.Background(), ident, "myproj", "main.tex", strings.NewReader("\\documentclass{article}")); err != nil {
		t.Fatalf("write: %v", err)
	}
	rc, err := s.ReadFile(context.Background(), ident, "myproj", "main.tex")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if !strings.Contains(string(b), "documentclass") {
		t.Errorf("readback = %q", string(b))
	}
}

func TestLocalStore_ListProjects(t *testing.T) {
	root := t.TempDir()
	s := NewLocalStore(root)
	ident := auth.Identity{Subject: "bob"}

	for _, name := range []string{"alpha", "beta", "gamma"} {
		_ = s.WriteFile(context.Background(), ident, name, "main.tex", strings.NewReader("x"))
	}
	projects, err := s.List(context.Background(), ident)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(projects) != 3 {
		t.Errorf("want 3 projects ; got %d", len(projects))
	}
	if projects[0].Name != "alpha" {
		t.Errorf("first = %q ; want alpha (sorted)", projects[0].Name)
	}
	if projects[0].Language != "latex" {
		t.Errorf("latex not detected from main.tex : got %q", projects[0].Language)
	}
}

func TestLocalStore_TraversalRefused(t *testing.T) {
	root := t.TempDir()
	s := NewLocalStore(root)
	ident := auth.Identity{Subject: "eve"}

	// Try to escape via "../" in the file path. The store must
	// refuse and not create anything outside <root>/eve/proj/.
	err := s.WriteFile(context.Background(), ident, "proj", "../../../etc/passwd", strings.NewReader("oops"))
	if err == nil {
		t.Error("traversal should have been refused")
	}
	// Verify no escape happened.
	if _, err := os.Stat(filepath.Join(root, "..", "..", "..", "etc", "passwd")); err == nil {
		t.Error("traversal succeeded — file landed outside root")
	}
}

func TestLocalStore_PerUserIsolation(t *testing.T) {
	root := t.TempDir()
	s := NewLocalStore(root)
	alice := auth.Identity{Subject: "alice"}
	bob := auth.Identity{Subject: "bob"}

	_ = s.WriteFile(context.Background(), alice, "shared", "secret.tex", strings.NewReader("alice's"))
	// Bob's "shared" project is a separate filesystem path. Reading
	// it returns nothing.
	files, _ := s.ListFiles(context.Background(), bob, "shared")
	if len(files) != 0 {
		t.Errorf("bob sees alice's files : %v", files)
	}
}

func TestSanitise(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"alice", "alice"},
		{"a-b_c", "a-b_c"},
		{"../etc", "etc"},
		{"http://dex/sub", "httpdexsub"},
		{"", ""},
	} {
		if got := sanitise(tc.in); got != tc.want {
			t.Errorf("sanitise(%q) = %q ; want %q", tc.in, got, tc.want)
		}
	}
}
