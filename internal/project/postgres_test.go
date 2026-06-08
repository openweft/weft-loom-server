package project

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// TestPostgresStore opt-in : set WEFT_LOOM_TEST_PG_DSN to a clean
// throwaway Postgres (e.g. via `docker run --rm -p 5432 postgres`).
// We refuse to run against a non-throwaway DB because the test
// deletes its own rows on cleanup, which would clobber a real one.
func testPGDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("WEFT_LOOM_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("set WEFT_LOOM_TEST_PG_DSN to run postgres-backed tests")
	}
	if !strings.Contains(dsn, "test") && !strings.Contains(dsn, "throwaway") {
		t.Skip("DSN must contain 'test' or 'throwaway' to confirm a non-prod database")
	}
	return dsn
}

func newPGStore(t *testing.T) *PostgresStore {
	t.Helper()
	root := t.TempDir()
	s, err := NewPostgresStore(context.Background(), testPGDSN(t), root)
	if err != nil {
		t.Fatalf("NewPostgresStore: %v", err)
	}
	t.Cleanup(func() {
		// Wipe rows the test inserted.
		_, _ = s.db.Exec(context.Background(), `DELETE FROM projects WHERE owner_subject LIKE 'test-%'`)
		s.Close()
	})
	return s
}

func TestPostgresStore_WriteCreatesProjectRowAndFile(t *testing.T) {
	s := newPGStore(t)
	ident := auth.Identity{Subject: "test-alice"}

	if err := s.WriteFile(context.Background(), ident, "thesis", "main.tex", strings.NewReader("\\documentclass{article}")); err != nil {
		t.Fatal(err)
	}
	projects, err := s.List(context.Background(), ident)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].Name != "thesis" || projects[0].Language != "latex" {
		t.Errorf("List = %+v ; want one project named thesis, language=latex", projects)
	}
}

func TestPostgresStore_ReadWriteRoundTrip(t *testing.T) {
	s := newPGStore(t)
	ident := auth.Identity{Subject: "test-bob"}

	want := "package main\n"
	if err := s.WriteFile(context.Background(), ident, "side", "go.mod", strings.NewReader(want)); err != nil {
		t.Fatal(err)
	}
	rc, err := s.ReadFile(context.Background(), ident, "side", "go.mod")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if string(got) != want {
		t.Errorf("readback = %q ; want %q", got, want)
	}
}

func TestPostgresStore_PerUserACL(t *testing.T) {
	s := newPGStore(t)
	alice := auth.Identity{Subject: "test-alice-acl"}
	bob := auth.Identity{Subject: "test-bob-acl"}

	_ = s.WriteFile(context.Background(), alice, "private", "secret.tex", strings.NewReader("alice's"))

	// Bob lists his own (zero) projects.
	bobs, _ := s.List(context.Background(), bob)
	if len(bobs) != 0 {
		t.Errorf("bob sees alice's projects : %v", bobs)
	}

	// Bob's READ of alice's project must 403 (ErrAccessDenied), not
	// 404 (which would leak project-name existence).
	if _, err := s.ReadFile(context.Background(), bob, "private", "secret.tex"); err != ErrAccessDenied {
		t.Errorf("bob ReadFile alice's = %v ; want ErrAccessDenied", err)
	}
}

func TestPostgresStore_TraversalRejected(t *testing.T) {
	s := newPGStore(t)
	ident := auth.Identity{Subject: "test-eve"}

	// Create the project first so authorize() passes — we want to
	// test that the FILE path rejects ".." not the project name.
	_ = s.WriteFile(context.Background(), ident, "proj", "ok.txt", strings.NewReader("hi"))
	err := s.WriteFile(context.Background(), ident, "proj", "../../../etc/passwd", strings.NewReader("nope"))
	if err == nil {
		t.Error("traversal should have been rejected")
	}
}
