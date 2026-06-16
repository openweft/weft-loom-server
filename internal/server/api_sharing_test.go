package server

// api_sharing_test.go — coverage for the per-project ACL handlers.
//
// The sharing surface flows through huma (mountSharingAPI). To keep
// these tests self-contained — independent of the rest of the routes
// the full Server boots — we mount JUST the sharing operations on a
// dedicated mux + huma API, wrapped by the same dev-mode identity
// injection ServeHTTP performs for the real server.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/project"
)

// newSharingTestServer spins up a Server + a thin mux that only
// exposes the 3 sharing endpoints. The identity is fixed to
// "dev-user" — same subject newTestServer in api_test.go relies on
// via dev-mode auth.
func newSharingTestServer(t *testing.T) (*httptest.Server, *project.LocalStore, *Server) {
	t.Helper()
	root := t.TempDir()
	store := project.NewLocalStore(root)
	s, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Projects: store,
		Compiler: compile.New(store),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mux := http.NewServeMux()
	api := humago.New(mux, huma.DefaultConfig("sharing-test", "v1"))
	mountSharingAPI(api, s)
	// Wrap the mux so the dev-mode identity ("dev-user") lives in ctx
	// before huma dispatches — mirrors what Server.ServeHTTP does in
	// production.
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ident, ok := s.identify(r)
		if !ok {
			ident = auth.Identity{Subject: "dev-user"}
		}
		r = r.WithContext(auth.WithIdentity(r.Context(), ident))
		mux.ServeHTTP(w, r)
	})
	return httptest.NewServer(wrapped), store, s
}

// seedSharingProject creates the project directory by writing one
// inert file. Required because the project store's resolveFile path
// rejects projects that don't yet have a host dir.
func seedSharingProject(t *testing.T, store *project.LocalStore, name string) {
	t.Helper()
	ident := auth.Identity{Subject: "dev-user"}
	if err := store.WriteFile(context.Background(), ident, name, "main.tex", strings.NewReader("x")); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func TestSharing_EmptyReturnsEmptyArray(t *testing.T) {
	srv, store, _ := newSharingTestServer(t)
	defer srv.Close()
	seedSharingProject(t, store, "thesis")

	resp, err := http.Get(srv.URL + "/api/projects/thesis/sharing")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}
	var body shareDoc
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Shares == nil {
		t.Fatalf("Shares is nil ; want empty slice (so JSON renders [] not null)")
	}
	if len(body.Shares) != 0 {
		t.Errorf("Shares = %v ; want []", body.Shares)
	}
}

func TestSharing_UpsertThenListReflectsAddition(t *testing.T) {
	srv, store, _ := newSharingTestServer(t)
	defer srv.Close()
	seedSharingProject(t, store, "thesis")

	// First upsert : new entry.
	resp, err := http.Post(
		srv.URL+"/api/projects/thesis/sharing",
		"application/json",
		bytes.NewReader([]byte(`{"user":"alice@example.com","role":"editor"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST status = %d ; want 200", resp.StatusCode)
	}

	// Second upsert : same user, new role — must replace, not duplicate.
	resp, err = http.Post(
		srv.URL+"/api/projects/thesis/sharing",
		"application/json",
		bytes.NewReader([]byte(`{"user":"alice@example.com","role":"viewer"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST status = %d ; want 200", resp.StatusCode)
	}

	// Third upsert : unknown role — must 400.
	resp, err = http.Post(
		srv.URL+"/api/projects/thesis/sharing",
		"application/json",
		bytes.NewReader([]byte(`{"user":"bob@example.com","role":"sysadmin"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown-role POST status = %d ; want 400", resp.StatusCode)
	}

	// GET reflects exactly the one (idempotent) entry.
	resp, err = http.Get(srv.URL + "/api/projects/thesis/sharing")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body shareDoc
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Shares) != 1 {
		t.Fatalf("Shares length = %d ; want 1 (idempotent upsert) ; got %+v", len(body.Shares), body.Shares)
	}
	if body.Shares[0].User != "alice@example.com" || body.Shares[0].Role != "viewer" {
		t.Errorf("Shares[0] = %+v ; want {alice@example.com viewer}", body.Shares[0])
	}
}

func TestSharing_DeleteRemoves(t *testing.T) {
	srv, store, _ := newSharingTestServer(t)
	defer srv.Close()
	seedSharingProject(t, store, "thesis")

	// Seed two shares so we can verify only the targeted one is gone.
	for _, payload := range []string{
		`{"user":"alice@example.com","role":"editor"}`,
		`{"user":"bob@example.com","role":"commenter"}`,
	} {
		resp, err := http.Post(
			srv.URL+"/api/projects/thesis/sharing",
			"application/json",
			bytes.NewReader([]byte(payload)),
		)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}

	// DELETE alice.
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/thesis/sharing/alice@example.com", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status = %d ; want 204", resp.StatusCode)
	}

	// List : only bob remains.
	resp, err = http.Get(srv.URL + "/api/projects/thesis/sharing")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body shareDoc
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Shares) != 1 {
		t.Fatalf("Shares length = %d ; want 1 ; got %+v", len(body.Shares), body.Shares)
	}
	if body.Shares[0].User != "bob@example.com" {
		t.Errorf("remaining share = %+v ; want bob@example.com", body.Shares[0])
	}

	// DELETE again on the same alice : idempotent — sidecar already
	// missing alice, response stays 204.
	req, _ = http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/thesis/sharing/alice@example.com", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("idempotent DELETE status = %d ; want 204", resp.StatusCode)
	}
}
