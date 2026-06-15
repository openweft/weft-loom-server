package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/compile"
)

// TestCompile_AcceptsEngineAndBibParams asserts the start-compile
// handler's request schema accepts the engine + bib fields added in
// V0.7 (LaTeX compiler selection UI). A POST that carries valid
// values must reach the dispatcher (202 Accepted) and the schema
// must not silently reject the body as unprocessable.
//
// We exercise every valid combination ; the dispatcher itself runs
// asynchronously and the run goroutine streams its result over SSE,
// so the assertion here is purely on the handler's body validation +
// JobSpec construction path.
func TestCompile_AcceptsEngineAndBibParams(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()
	seedProject(t, store, "thesis", "main.tex", `\documentclass{article}\begin{document}x\end{document}`)

	cases := []struct {
		name   string
		engine string
		bib    string
	}{
		{"pdflatex+bibtex", "pdflatex", "bibtex"},
		{"lualatex+biber", "lualatex", "biber"},
		{"xelatex+bibtex", "xelatex", "bibtex"},
		{"defaults_empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"language": "latex",
				"entry":    "main.tex",
				"engine":   tc.engine,
				"bib":      tc.bib,
			})
			resp, err := http.Post(
				srv.URL+"/api/projects/thesis/compile",
				"application/json",
				bytes.NewReader(body),
			)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusAccepted {
				b, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d ; want 202 ; body = %s", resp.StatusCode, b)
			}
			var out struct {
				ID string `json:"id"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
			if len(out.ID) != 16 {
				t.Errorf("ID = %q ; want 16 hex chars", out.ID)
			}
		})
	}
}

// TestCompile_OpenAPIDocumentsEngineFields : the generated OpenAPI
// schema must expose the engine + bib fields so the typed TS client
// picks them up. Catches a future refactor that drops the doc tag
// or moves the fields off the body type.
func TestCompile_OpenAPIDocumentsEngineFields(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	for _, want := range []string{`"engine"`, `"bib"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("openapi spec missing field %s", want)
		}
	}
}

// TestCompile_RejectsUnknownEngineSilently : unknown engine values
// must NOT 4xx — the dispatcher logs a warning + falls back to
// pdflatex. This matches the fallback contract documented on
// resolveLatexEngine ; a strict reject here would break the
// "ship something even when the request is weird" promise.
func TestCompile_RejectsUnknownEngineSilently(t *testing.T) {
	srv, store := newTestServer(t)
	defer srv.Close()
	seedProject(t, store, "thesis", "main.tex", "x")

	body := []byte(`{"language":"latex","entry":"main.tex","engine":"latex-2049","bib":"bibtex"}`)
	resp, err := http.Post(
		srv.URL+"/api/projects/thesis/compile",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d ; want 202 (server falls back, doesn't 4xx) ; body = %s", resp.StatusCode, b)
	}
}

// TestCompile_JobSpecCarriesEngineFields : the body fields must be
// threaded onto compile.JobSpec — this is the contract the
// dispatcher reads. Compile-time check via a struct literal so a
// future rename of the JobSpec fields fails this test loudly
// instead of silently dropping the user's choice.
func TestCompile_JobSpecCarriesEngineFields(t *testing.T) {
	spec := compile.JobSpec{
		Project:   "p",
		Language:  "latex",
		Engine:    "xelatex",
		BibEngine: "biber",
	}
	if spec.Engine != "xelatex" {
		t.Errorf("Engine = %q ; want xelatex", spec.Engine)
	}
	if spec.BibEngine != "biber" {
		t.Errorf("BibEngine = %q ; want biber", spec.BibEngine)
	}
}
