package server

// api_snippets_test.go — coverage for the per-project user-snippets
// handlers. Mirrors the api_sharing_test.go layout : spin a thin mux
// + huma API that mounts only mountSnippetsAPI, wrap with the same
// dev-mode identity injection ServeHTTP performs in production.

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

// newSnippetsTestServer spins a Server + a thin mux that only exposes
// the 3 snippets endpoints, under the dev "dev-user" identity.
func newSnippetsTestServer(t *testing.T) (*httptest.Server, *project.LocalStore, *Server) {
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
	api := humago.New(mux, huma.DefaultConfig("snippets-test", "v1"))
	mountSnippetsAPI(api, s)
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

// seedSnippetsProject pins a project dir into existence — the project
// store's resolveFile path rejects projects with no host dir.
func seedSnippetsProject(t *testing.T, store *project.LocalStore, name string) {
	t.Helper()
	ident := auth.Identity{Subject: "dev-user"}
	if err := store.WriteFile(context.Background(), ident, name, "main.tex", strings.NewReader("x")); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

// snippetsListBody is the wire shape returned by GET /snippets ; a
// local copy of snippetListOutput.Body so the test doesn't depend on
// huma's reflected envelope name.
type snippetsListBody struct {
	Snippets []userSnippet `json:"snippets"`
}

func TestSnippets_EmptyReturnsEmptyArray(t *testing.T) {
	srv, store, _ := newSnippetsTestServer(t)
	defer srv.Close()
	seedSnippetsProject(t, store, "thesis")

	resp, err := http.Get(srv.URL + "/api/projects/thesis/snippets")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}
	var body snippetsListBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Snippets == nil {
		t.Fatalf("Snippets is nil ; want empty slice (so JSON renders [] not null)")
	}
	if len(body.Snippets) != 0 {
		t.Errorf("Snippets = %v ; want []", body.Snippets)
	}
}

func TestSnippets_UpsertThenListReflectsAddition(t *testing.T) {
	srv, store, _ := newSnippetsTestServer(t)
	defer srv.Close()
	seedSnippetsProject(t, store, "thesis")

	// Upsert with an explicit id — round-trips verbatim.
	resp, err := http.Post(
		srv.URL+"/api/projects/thesis/snippets",
		"application/json",
		bytes.NewReader([]byte(`{"id":"preamble","label":"My preamble","body":"\\usepackage{tikz}\n","scope":"latex"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST status = %d ; want 200", resp.StatusCode)
	}

	// Re-upsert the same id with a different label — must replace,
	// not duplicate.
	resp, err = http.Post(
		srv.URL+"/api/projects/thesis/snippets",
		"application/json",
		bytes.NewReader([]byte(`{"id":"preamble","label":"My preamble v2","body":"\\usepackage{tikz}\n\\usepackage{amsmath}\n","scope":"latex"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST replace status = %d ; want 200", resp.StatusCode)
	}

	// Upsert WITHOUT an id — server generates one + returns it.
	resp, err = http.Post(
		srv.URL+"/api/projects/thesis/snippets",
		"application/json",
		bytes.NewReader([]byte(`{"label":"Quick cite","body":"\\cite{}"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST autogen status = %d ; want 200", resp.StatusCode)
	}
	var auto userSnippet
	if err := json.NewDecoder(resp.Body).Decode(&auto); err != nil {
		t.Fatal(err)
	}
	if !snippetIDRe.MatchString(auto.ID) {
		t.Errorf("auto-generated id %q does not match validator regex", auto.ID)
	}

	// Empty label — must 400.
	resp2, err := http.Post(
		srv.URL+"/api/projects/thesis/snippets",
		"application/json",
		bytes.NewReader([]byte(`{"label":"","body":"x"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Errorf("empty-label POST status = %d ; want 400", resp2.StatusCode)
	}

	// GET reflects the two distinct snippets — the replaced "preamble"
	// (carrying v2's label + body) plus the auto-id Quick cite.
	resp3, err := http.Get(srv.URL + "/api/projects/thesis/snippets")
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	var body snippetsListBody
	if err := json.NewDecoder(resp3.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Snippets) != 2 {
		t.Fatalf("Snippets length = %d ; want 2 (preamble replaced + auto-id) ; got %+v", len(body.Snippets), body.Snippets)
	}
	// Find the preamble entry — order is insertion order so it's [0].
	var preamble *userSnippet
	for i := range body.Snippets {
		if body.Snippets[i].ID == "preamble" {
			preamble = &body.Snippets[i]
		}
	}
	if preamble == nil {
		t.Fatalf("preamble entry not found in %+v", body.Snippets)
	}
	if preamble.Label != "My preamble v2" {
		t.Errorf("preamble.Label = %q ; want \"My preamble v2\" (idempotent replace)", preamble.Label)
	}
	if !strings.Contains(preamble.Body, "amsmath") {
		t.Errorf("preamble.Body = %q ; want the v2 body containing amsmath", preamble.Body)
	}
}

func TestSnippets_DeleteRemoves(t *testing.T) {
	srv, store, _ := newSnippetsTestServer(t)
	defer srv.Close()
	seedSnippetsProject(t, store, "thesis")

	// Seed two snippets so we can verify only the targeted one disappears.
	for _, payload := range []string{
		`{"id":"alpha","label":"Alpha","body":"A"}`,
		`{"id":"beta","label":"Beta","body":"B"}`,
	} {
		resp, err := http.Post(
			srv.URL+"/api/projects/thesis/snippets",
			"application/json",
			bytes.NewReader([]byte(payload)),
		)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}

	// DELETE alpha.
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/thesis/snippets/alpha", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status = %d ; want 204", resp.StatusCode)
	}

	// List : only beta remains.
	resp, err = http.Get(srv.URL + "/api/projects/thesis/snippets")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body snippetsListBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Snippets) != 1 {
		t.Fatalf("Snippets length = %d ; want 1 ; got %+v", len(body.Snippets), body.Snippets)
	}
	if body.Snippets[0].ID != "beta" {
		t.Errorf("remaining snippet = %+v ; want id=beta", body.Snippets[0])
	}

	// DELETE again on alpha : idempotent — still 204.
	req2, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/thesis/snippets/alpha", nil)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Errorf("idempotent DELETE status = %d ; want 204", resp2.StatusCode)
	}
}

func TestSnippets_InvalidIDRejectedAt400(t *testing.T) {
	srv, store, _ := newSnippetsTestServer(t)
	defer srv.Close()
	seedSnippetsProject(t, store, "thesis")

	// POST with a bad id (contains a space + special chars + > 64 chars).
	resp, err := http.Post(
		srv.URL+"/api/projects/thesis/snippets",
		"application/json",
		bytes.NewReader([]byte(`{"id":"bad id with spaces!","label":"x","body":"y"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("POST bad-id status = %d ; want 400", resp.StatusCode)
	}

	// DELETE with a bad id — same 400.
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/thesis/snippets/spaces%20here", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("DELETE bad-id status = %d ; want 400 ; got %d", resp.StatusCode, resp.StatusCode)
	}
}
