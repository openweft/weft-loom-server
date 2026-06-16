package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRenameProject_HappyPath : seed a project, hit
// POST /api/projects/{name}/rename, expect 200 + updated projectOut +
// the directory actually moved on disk.
func TestRenameProject_HappyPath(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()

	seedProject(t, store, "thesis", "main.tex", "\\documentclass{article}")
	// Confirm the source directory exists where we expect.
	srcDir := filepath.Join(store.Root(), "dev-user", "thesis")
	if _, err := os.Stat(srcDir); err != nil {
		t.Fatalf("seed didn't land at %s : %v", srcDir, err)
	}

	body := strings.NewReader(`{"newName":"phd-thesis"}`)
	resp, err := http.Post(srv.URL+"/api/projects/thesis/rename", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(resp.Body)
		t.Fatalf("status = %d ; want 200 ; body = %s", resp.StatusCode, buf.String())
	}
	var out struct {
		Name     string `json:"name"`
		Language string `json:"language"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Name != "phd-thesis" {
		t.Errorf("Name = %q ; want phd-thesis", out.Name)
	}
	if out.Language != "latex" {
		t.Errorf("Language = %q ; want latex (main.tex sidecar travelled with the dir)", out.Language)
	}

	// Filesystem-level assertion : the directory actually moved.
	dstDir := filepath.Join(store.Root(), "dev-user", "phd-thesis")
	if _, err := os.Stat(dstDir); err != nil {
		t.Errorf("dst %s missing after rename : %v", dstDir, err)
	}
	if _, err := os.Stat(srcDir); !os.IsNotExist(err) {
		t.Errorf("src %s still present after rename : err = %v", srcDir, err)
	}
	// main.tex travelled too.
	if _, err := os.Stat(filepath.Join(dstDir, "main.tex")); err != nil {
		t.Errorf("main.tex missing under dst : %v", err)
	}
}

// TestRenameProject_DestExists : if the target name already has a
// directory, the API returns 409 and neither directory moves.
func TestRenameProject_DestExists(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()

	seedProject(t, store, "src", "main.tex", "x")
	seedProject(t, store, "dst", "main.tex", "y")

	body := strings.NewReader(`{"newName":"dst"}`)
	resp, err := http.Post(srv.URL+"/api/projects/src/rename", "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(resp.Body)
		t.Errorf("status = %d ; want 409 ; body = %s", resp.StatusCode, buf.String())
	}
	// Both still on disk, untouched.
	for _, n := range []string{"src", "dst"} {
		if _, err := os.Stat(filepath.Join(store.Root(), "dev-user", n)); err != nil {
			t.Errorf("%s vanished after failed rename : %v", n, err)
		}
	}
}

// TestRenameProject_InvalidName : the API refuses path separators,
// reserved .weft-loom prefix, and the empty string with 400.
func TestRenameProject_InvalidName(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()
	seedProject(t, store, "p1", "main.tex", "x")

	for _, bad := range []string{
		`{"newName":""}`,            // empty
		`{"newName":"foo/bar"}`,     // path separator
		`{"newName":".weft-loom"}`,  // reserved
		`{"newName":".dotfile"}`,    // leading dot
		`{"newName":"with space"}`,  // sanitise() strips → mismatch
		`{"newName":"héllo"}`,       // non-ASCII → sanitise mismatch
	} {
		resp, err := http.Post(srv.URL+"/api/projects/p1/rename", "application/json", strings.NewReader(bad))
		if err != nil {
			t.Fatalf("post %s : %v", bad, err)
		}
		resp.Body.Close()
		// huma's own validator returns 422 when minLength:"1" rejects
		// the empty-string case before the handler runs ; our handler
		// returns 400 for everything else. Both indicate the bad name
		// was refused.
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("body %s : status = %d ; want 400 or 422", bad, resp.StatusCode)
		}
	}
}
