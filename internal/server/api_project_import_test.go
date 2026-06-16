package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/project"
)

// newImportTestServer mirrors newTestServer (api_test.go) but returns
// the bare *Server pointer so the import test can call
// handleProjectImport directly. The route isn't registered in mux yet
// (integration step) so we drive the handler with an httptest
// recorder + r.SetPathValue. We still inject the dev identity into
// the request context, same as requireAuth would.
func newImportTestServer(t *testing.T) (*Server, *project.LocalStore) {
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
	return s, store
}

// importRequest builds a POST /import multipart request preloaded
// with the supplied zip bytes under field "zip", the requested
// project name in {name}, and a dev-mode identity in context.
func importRequest(t *testing.T, project string, zipBytes []byte, query string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("zip", "upload.zip")
	if err != nil {
		t.Fatalf("CreateFormFile : %v", err)
	}
	if _, err := part.Write(zipBytes); err != nil {
		t.Fatalf("part.Write : %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("mw.Close : %v", err)
	}
	url := "/api/projects/" + project + "/import"
	if query != "" {
		url += "?" + query
	}
	r := httptest.NewRequest(http.MethodPost, url, &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.SetPathValue("name", project)
	r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{Subject: "dev-user"}))
	return r
}

// buildZip is a tiny helper that produces a valid in-memory zip from
// a path→content map. Used to construct test fixtures + zip-slip
// payloads without leaning on disk.
func buildZip(t *testing.T, files map[string]string, dirs ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for path, content := range files {
		fw, err := zw.Create(path)
		if err != nil {
			t.Fatalf("zw.Create(%q) : %v", path, err)
		}
		if _, err := fw.Write([]byte(content)); err != nil {
			t.Fatalf("fw.Write(%q) : %v", path, err)
		}
	}
	for _, d := range dirs {
		if _, err := zw.Create(d); err != nil { // trailing slash → dir entry
			t.Fatalf("zw.Create(dir %q) : %v", d, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zw.Close : %v", err)
	}
	return buf.Bytes()
}

// TestProjectImport_RoundTrip seeds a project, runs the export
// handler to obtain a ZIP, imports it into a fresh project, then
// verifies every file contents via store.ReadFile. The round-trip
// is the canonical smoke test for the symmetry promised by the two
// handlers.
func TestProjectImport_RoundTrip(t *testing.T) {
	s, store := newImportTestServer(t)

	// Seed source project.
	ident := auth.Identity{Subject: "dev-user"}
	want := map[string]string{
		"main.tex":         "\\documentclass{article}\n",
		"refs/biblio.bib":  "@book{x, title={X}}\n",
		"chapters/one.tex": "chapter one\n",
	}
	for path, content := range want {
		seedProject(t, store, "src", path, content)
	}

	// Capture export bytes by invoking the handler with a recorder.
	expReq := httptest.NewRequest(http.MethodGet, "/api/projects/src/export.zip", nil)
	expReq.SetPathValue("name", "src")
	expReq = expReq.WithContext(auth.WithIdentity(expReq.Context(), ident))
	expRec := httptest.NewRecorder()
	s.handleProjectExport(expRec, expReq)
	if expRec.Code != http.StatusOK {
		t.Fatalf("export status = %d ; want 200", expRec.Code)
	}
	zipBytes := expRec.Body.Bytes()
	if len(zipBytes) == 0 {
		t.Fatal("export produced empty body")
	}

	// Import into a fresh project.
	impRec := httptest.NewRecorder()
	s.handleProjectImport(impRec, importRequest(t, "dst", zipBytes, ""))
	if impRec.Code != http.StatusOK {
		t.Fatalf("import status = %d ; body = %s", impRec.Code, impRec.Body.String())
	}
	var summary struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal(impRec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode summary : %v", err)
	}
	if summary.Imported != len(want) {
		t.Errorf("imported = %d ; want %d ; body = %s", summary.Imported, len(want), impRec.Body.String())
	}

	// Verify each file's contents survived the round-trip.
	for path, expected := range want {
		rc, err := store.ReadFile(context.Background(), ident, "dst", path)
		if err != nil {
			t.Errorf("ReadFile(dst, %q) : %v", path, err)
			continue
		}
		got, _ := io.ReadAll(rc)
		_ = rc.Close()
		if string(got) != expected {
			t.Errorf("dst/%s = %q ; want %q", path, got, expected)
		}
	}
}

// TestProjectImport_RejectZipSlip verifies the handler refuses
// archives with ".." or absolute paths. A hostile archive must
// produce a 400 + leave no files on disk in the target project.
func TestProjectImport_RejectZipSlip(t *testing.T) {
	cases := []struct {
		name  string
		entry string
	}{
		{name: "parent_traversal", entry: "../escaped.tex"},
		{name: "absolute", entry: "/etc/passwd"},
		{name: "nested_traversal", entry: "foo/../../bar.tex"},
		{name: "windows_backslash", entry: "..\\evil.tex"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, store := newImportTestServer(t)
			zipBytes := buildZip(t, map[string]string{tc.entry: "pwned"})

			rec := httptest.NewRecorder()
			s.handleProjectImport(rec, importRequest(t, "victim", zipBytes, ""))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d ; want 400 ; body = %s", rec.Code, rec.Body.String())
			}
			// Project must remain empty — no partial writes.
			ident := auth.Identity{Subject: "dev-user"}
			files, err := store.ListFiles(context.Background(), ident, "victim")
			if err == nil && len(files) > 0 {
				for _, f := range files {
					if !f.Dir {
						t.Errorf("unexpected leftover after rejected import : %q", f.Path)
					}
				}
			}
		})
	}
}

// TestProjectImport_SkipDirEntries confirms that bare directory
// entries (zero-length, trailing slash) are counted in `skipped` and
// not surfaced as empty files in the target project.
func TestProjectImport_SkipDirEntries(t *testing.T) {
	s, store := newImportTestServer(t)
	zipBytes := buildZip(t,
		map[string]string{"main.tex": "ok\n"},
		"chapters/", "refs/", // pure directory entries
	)

	rec := httptest.NewRecorder()
	s.handleProjectImport(rec, importRequest(t, "dst", zipBytes, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d ; body = %s", rec.Code, rec.Body.String())
	}
	var summary struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode : %v", err)
	}
	if summary.Imported != 1 {
		t.Errorf("imported = %d ; want 1", summary.Imported)
	}
	if summary.Skipped < 2 {
		t.Errorf("skipped = %d ; want >= 2 (two dir entries)", summary.Skipped)
	}
	// Sanity : only main.tex was written.
	ident := auth.Identity{Subject: "dev-user"}
	rc, err := store.ReadFile(context.Background(), ident, "dst", "main.tex")
	if err != nil {
		t.Fatalf("ReadFile main.tex : %v", err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if string(got) != "ok\n" {
		t.Errorf("main.tex = %q ; want %q", got, "ok\n")
	}
}

// TestProjectImport_SkipExportPaths verifies the default skip list
// (.weft-loom/, .git/objects/pack/) is honoured on import so a
// straight round-trip stays clean. ?include=all bypasses it.
func TestProjectImport_SkipExportPaths(t *testing.T) {
	s, store := newImportTestServer(t)
	zipBytes := buildZip(t, map[string]string{
		"main.tex":                        "kept\n",
		".weft-loom/history/snap.bin":     "internal\n",
		".git/objects/pack/pack-abc.pack": "huge\n",
	})

	rec := httptest.NewRecorder()
	s.handleProjectImport(rec, importRequest(t, "dst", zipBytes, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d ; body = %s", rec.Code, rec.Body.String())
	}
	var summary struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode : %v", err)
	}
	if summary.Imported != 1 || summary.Skipped < 2 {
		t.Errorf("summary = %+v ; want imported=1 skipped>=2", summary)
	}

	// ?include=all flips the switch.
	s2, _ := newImportTestServer(t)
	rec2 := httptest.NewRecorder()
	s2.handleProjectImport(rec2, importRequest(t, "dst", zipBytes, "include=all"))
	if rec2.Code != http.StatusOK {
		t.Fatalf("include=all status = %d ; body = %s", rec2.Code, rec2.Body.String())
	}
	var summary2 struct {
		Imported int `json:"imported"`
		Skipped  int `json:"skipped"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &summary2); err != nil {
		t.Fatalf("decode : %v", err)
	}
	if summary2.Imported != 3 {
		t.Errorf("include=all imported = %d ; want 3", summary2.Imported)
	}

	// Silence the unused-store warning when no further assertions hit.
	_ = store
}
