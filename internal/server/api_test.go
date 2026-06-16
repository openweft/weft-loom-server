package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/project"
)

// newTestServer builds a Server backed by a temp-dir LocalStore +
// the compile stub. Returns a Server already mounted on an
// httptest.Server so tests can curl it.
func newTestServer(t *testing.T) (*httptest.Server, *project.LocalStore) {
	t.Helper()
	root := t.TempDir()
	store := project.NewLocalStore(root)
	s, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Projects: store,
		Compiler: compile.New(store),
		// Auth nil = dev mode, every request gets "dev-user" identity.
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return httptest.NewServer(s), store
}

// seedProject writes one file to a project so List + ListFiles have
// something to return. Bypasses HTTP — directly drives the store.
func seedProject(t *testing.T, store *project.LocalStore, name, path, content string) {
	t.Helper()
	ident := auth.Identity{Subject: "dev-user"}
	if err := store.WriteFile(context.Background(), ident, name, path, strings.NewReader(content)); err != nil {
		t.Fatalf("seed %s/%s: %v", name, path, err)
	}
}

func TestHumaListProjects_Empty(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 0 {
		t.Errorf("Items = %v ; want []", body.Items)
	}
}

func TestHumaListProjects_Populated(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()

	seedProject(t, store, "thesis", "main.tex", "x")
	// detectLanguage probes for go.mod (not main.go) — Go module
	// presence is the canonical Go-project marker openweft uses.
	seedProject(t, store, "side", "go.mod", "module side\n")

	resp, err := http.Get(srv.URL + "/api/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}
	var body struct {
		Items []struct {
			Name     string `json:"name"`
			Language string `json:"language"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 2 {
		t.Fatalf("Items length = %d ; want 2 ; got %+v", len(body.Items), body.Items)
	}
	// Sorted alpha : side first, thesis second.
	if body.Items[0].Name != "side" || body.Items[0].Language != "go" {
		t.Errorf("Items[0] = %+v ; want {name=side language=go}", body.Items[0])
	}
	if body.Items[1].Name != "thesis" || body.Items[1].Language != "latex" {
		t.Errorf("Items[1] = %+v ; want {name=thesis language=latex}", body.Items[1])
	}
}

func TestHumaListFiles(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()

	seedProject(t, store, "proj", "main.tex", "x")
	seedProject(t, store, "proj", "refs/biblio.bib", "y")

	resp, err := http.Get(srv.URL + "/api/projects/proj/files")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var body struct {
		Items []struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
			Dir  bool   `json:"dir"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	paths := map[string]bool{}
	dirs := map[string]bool{}
	for _, f := range body.Items {
		paths[f.Path] = true
		if f.Dir {
			dirs[f.Path] = true
		}
	}
	for _, want := range []string{"main.tex", "refs", "refs/biblio.bib"} {
		if !paths[want] {
			t.Errorf("missing %q in listing ; got %v", want, paths)
		}
	}
	if !dirs["refs"] {
		t.Errorf("refs not marked as dir")
	}
}

func TestHumaStartCompile_ValidatesLanguage(t *testing.T) {
	// huma's request validation must reject a missing required field
	// (language is `required` in the schema) BEFORE the handler runs.
	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Post(
		srv.URL+"/api/projects/proj/compile",
		"application/json",
		bytes.NewReader([]byte(`{"entry": "main.tex"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity && resp.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("missing-language POST status = %d ; want 422 or 400 ; body = %s", resp.StatusCode, body)
	}
}

func TestHumaStartCompile_AcceptedReturnsID(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()

	seedProject(t, store, "proj", "main.tex", "x")

	resp, err := http.Post(
		srv.URL+"/api/projects/proj/compile",
		"application/json",
		bytes.NewReader([]byte(`{"language": "latex", "entry": "main.tex"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d ; want 202 ; body = %s", resp.StatusCode, body)
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.ID) != 16 {
		t.Errorf("ID = %q ; want 16 hex chars", body.ID)
	}
}

// TestHumaOpenAPI_Published : the spec endpoint is reachable + valid
// JSON with our 3 operations. This is the test that catches a broken
// huma registration before it ships.
func TestHumaOpenAPI_Published(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var spec struct {
		Paths map[string]any `json:"paths"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&spec); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"/api/projects",
		"/api/projects/{name}/files",
		"/api/projects/{name}/compile",
	} {
		if _, ok := spec.Paths[want]; !ok {
			t.Errorf("openapi missing path %q ; have %v", want, mapKeys(spec.Paths))
		}
	}
}

// TestHumaRawHandlers_StillAuthGuarded : the SSE + WS + binary file
// IO routes (not on huma) still refuse unauthenticated requests. Tied
// to the static fake bearer below.
func TestHumaRawHandlers_StillAuthGuarded(t *testing.T) {
	// Build a server with a StaticVerifier — dev mode (Auth=nil)
	// would synthesise an identity for every request, defeating
	// the test.
	root := t.TempDir()
	store := project.NewLocalStore(root)
	s, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Projects: store,
		Compiler: compile.New(store),
		Auth: auth.StaticVerifier{
			Token:    "secret",
			Identity: auth.Identity{Subject: "alice"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s)
	defer srv.Close()

	// No bearer ; the SSE compile stream + binary read must 401.
	for _, path := range []string{
		"/api/projects/proj/files/main.tex", // read file (raw handler)
		"/api/projects/proj/compile/abc",    // compile stream (raw)
	} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s : status = %d ; want 401 with missing bearer", path, resp.StatusCode)
		}
	}

	// With bearer : the same calls reach the handler (404 for compile
	// id, that's fine — we asserted auth let us in).
	req, _ := http.NewRequest("GET", srv.URL+"/api/projects/proj/compile/abc", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		t.Errorf("compile stream with bearer = 401 ; expected to pass auth")
	}
}

// TestInternalPathBlocked pins the privilege-escalation fix : an
// authenticated user must not be able to read/write/list .weft-loom/
// via the generic /files/ endpoints. Pre-fix, any authed user could
// PUT .weft-loom/owner with their own subject and become the project
// owner, then add themselves as a collaborator via the sharing API.
func TestInternalPathBlocked(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()
	seedProject(t, store, "p1", "paper.tex", "hello")
	// Seed an internal sidecar directly so the listing has something
	// to potentially leak.
	seedProject(t, store, "p1", ".weft-loom/owner", "alice")

	// 1. GET refuses .weft-loom/ paths.
	r1, err := http.Get(srv.URL + "/api/projects/p1/files/.weft-loom/owner")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	r1.Body.Close()
	if r1.StatusCode != http.StatusNotFound {
		t.Errorf("GET .weft-loom/owner = %d ; want 404", r1.StatusCode)
	}

	// 2. PUT refuses .weft-loom/ paths (the escalation vector).
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/projects/p1/files/.weft-loom/owner", strings.NewReader("attacker"))
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT: %v", err)
	}
	r2.Body.Close()
	if r2.StatusCode != http.StatusForbidden {
		t.Errorf("PUT .weft-loom/owner = %d ; want 403", r2.StatusCode)
	}

	// 3. DELETE refuses .weft-loom/ paths.
	req, _ = http.NewRequest(http.MethodDelete, srv.URL+"/api/projects/p1/files/.weft-loom/owner", nil)
	r3, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	r3.Body.Close()
	if r3.StatusCode != http.StatusForbidden {
		t.Errorf("DELETE .weft-loom/owner = %d ; want 403", r3.StatusCode)
	}

	// 4. Listing must not surface .weft-loom/* paths.
	r4, err := http.Get(srv.URL + "/api/projects/p1/files")
	if err != nil {
		t.Fatalf("LIST: %v", err)
	}
	defer r4.Body.Close()
	body, _ := io.ReadAll(r4.Body)
	if strings.Contains(string(body), ".weft-loom") {
		t.Errorf("listing leaked .weft-loom : %s", body)
	}
}

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// keep imports live in case future refactor removes their first use.
var _ = fmt.Sprintf
