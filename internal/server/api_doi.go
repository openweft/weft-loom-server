package server

// api_doi.go — POST /api/projects/{name}/bib/from-doi
//
// Resolves a DOI to a BibTeX entry by hitting doi.org with the
// special `Accept: application/x-bibtex` content negotiation header.
// doi.org delegates to the publisher's metadata server which speaks
// CSL JSON natively + transforms to BibTeX on the fly. The result is
// appended to the target .bib file (default: refs.bib, created if
// missing).
//
// Wire shape :
//   request  : { doi: "10.1145/3676146", target?: "refs.bib" }
//   response : { entry: "@article{...}", target: "refs.bib", appended: true }
//   errors   : 400 invalid doi, 502 upstream unreachable
//
// Test mode : when WEFT_LOOM_DOI_STUB=1 the resolver short-circuits
// to a deterministic stub entry so the puppeteer test doesn't depend
// on the public internet.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// doiPattern : the standard DOI grammar — "10." + a registrant code
// (digits) + "/" + an opaque suffix. We accept either a bare DOI or
// a doi.org / dx.doi.org URL ; the resolver normalises to the bare
// form before hitting the upstream service.
var doiPattern = regexp.MustCompile(`(?i)^(?:https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/[^\s]+)$`)

func extractDOI(input string) (string, bool) {
	m := doiPattern.FindStringSubmatch(strings.TrimSpace(input))
	if m == nil {
		return "", false
	}
	return m[1], true
}

// resolveDOIToBibTeX fetches the BibTeX-formatted entry for the
// given DOI. Returns the raw entry string + an error on failure.
// Honours WEFT_LOOM_DOI_STUB for hermetic tests.
func resolveDOIToBibTeX(ctx context.Context, doi string) (string, error) {
	if os.Getenv("WEFT_LOOM_DOI_STUB") == "1" {
		// Deterministic stub so the test doesn't hit the network.
		// Mimics the wire shape doi.org returns (one entry, BibTeX
		// with a stable key).
		safeKey := strings.ReplaceAll(strings.ReplaceAll(doi, "/", "_"), ".", "_")
		return "@article{" + safeKey + ",\n" +
			"  title = {Stubbed Title for " + doi + "},\n" +
			"  author = {Stub, Author},\n" +
			"  year = {2026},\n" +
			"  doi = {" + doi + "},\n" +
			"  journal = {Stub Journal},\n" +
			"}\n", nil
	}
	u := "https://doi.org/" + url.PathEscape(doi)
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, u, nil)
	if err != nil {
		return "", fmt.Errorf("doi: build request: %w", err)
	}
	req.Header.Set("Accept", "application/x-bibtex; charset=utf-8")
	req.Header.Set("User-Agent", "weft-loom-server/1.0 (https://github.com/openweft/weft-loom-server)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("doi: upstream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("doi: not found (404)")
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("doi: upstream returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", fmt.Errorf("doi: read body: %w", err)
	}
	entry := strings.TrimSpace(string(body))
	if !strings.HasPrefix(entry, "@") {
		// Some metadata servers (CrossRef, DataCite) ignore the
		// Accept header and return plain text or HTML. Fail loud
		// so the user sees a useful error.
		return "", fmt.Errorf("doi: upstream returned %d bytes that don't look like BibTeX", len(body))
	}
	if !strings.HasSuffix(entry, "\n") {
		entry += "\n"
	}
	return entry, nil
}

// pickTargetBib chooses where to append the new BibTeX entry :
//   - explicit `target` from the request when provided
//   - otherwise the first `.bib` file the ListFiles walker surfaces
//   - otherwise "refs.bib" (created on demand by the write path)
func (s *Server) pickTargetBib(ctx context.Context, ident auth.Identity, project, requested string) string {
	if requested != "" && strings.HasSuffix(strings.ToLower(requested), ".bib") {
		return requested
	}
	files, err := s.opts.Projects.ListFiles(ctx, ident, project)
	if err != nil {
		return "refs.bib"
	}
	for _, f := range files {
		if f.Dir {
			continue
		}
		if strings.HasSuffix(strings.ToLower(f.Path), ".bib") {
			return f.Path
		}
	}
	return "refs.bib"
}

func (s *Server) handleDOIToBib(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)

	var body struct {
		DOI    string `json:"doi"`
		Target string `json:"target,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	doi, ok := extractDOI(body.DOI)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "doi: not a valid DOI (expected 10.NNNN/suffix or a doi.org URL)"})
		return
	}
	entry, err := resolveDOIToBibTeX(r.Context(), doi)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	target := s.pickTargetBib(r.Context(), ident, proj, body.Target)
	// Defence in depth : never write into the server-side sidecar
	// namespace from user-supplied target paths. The .bib suffix
	// check in pickTargetBib bounds the shape, but the path can still
	// be .weft-loom/x.bib.
	if isInternalPath(target) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "target path is reserved"})
		return
	}

	// Append to (or create) the target .bib. We don't dedupe — the
	// user may legitimately have two entries for the same DOI in
	// different bibliographies, and dedup against an arbitrary
	// citation key is brittle.
	var combined []byte
	existing, err := s.opts.Projects.ReadFile(r.Context(), ident, proj, target)
	if err == nil {
		buf, _ := io.ReadAll(existing)
		_ = existing.Close()
		combined = buf
		if len(combined) > 0 && !bytes.HasSuffix(combined, []byte("\n")) {
			combined = append(combined, '\n')
		}
	}
	combined = append(combined, []byte(entry)...)

	if werr := s.opts.Projects.WriteFile(r.Context(), ident, proj, target, bytes.NewReader(combined)); werr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "write: " + werr.Error()})
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "doi", Verb: "import",
		Project: proj,
		Fields:  map[string]any{"doi": doi, "target": target, "bytes": len(entry)},
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"entry":    entry,
		"target":   target,
		"appended": true,
	})
}
