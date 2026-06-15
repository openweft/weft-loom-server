package server

// api_zotero.go — POST /api/projects/{name}/zotero/sync
//
// Relays a sync request to the Zotero REST API. The user pastes
// their Zotero userID + a personal API key into the SettingsPanel ;
// the SPA sends both in the JSON body of this handler ; we GET
// `https://api.zotero.org/users/<userID>/items?format=bibtex` with
// `Authorization: Bearer <apiKey>` and stream the BibTeX bytes back
// to the client as `text/plain`. The client is responsible for
// appending the result to refs.bib via the existing file-write API.
//
// Wire shape :
//   request  : POST { "user_id": "12345", "api_key": "abc123" }
//   response : 200 text/plain ; body = raw BibTeX from Zotero
//   errors   : 400 missing user_id or api_key (JSON envelope)
//              401 upstream rejected the API key (JSON envelope, mirrors
//                  upstream status so the SPA can surface a useful error)
//              502 upstream unreachable / malformed (JSON envelope)
//
// The upstream URL lives in a package var so tests can swap in an
// httptest.Server — same hook the arXiv handler uses.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// zoteroUpstream is the base URL for the Zotero REST API. Tests
// flip this to an httptest.Server. Production points at the public
// service.
var zoteroUpstream = "https://api.zotero.org"

// zoteroSyncRequest is the JSON body the SPA POSTs.
type zoteroSyncRequest struct {
	UserID string `json:"user_id"`
	APIKey string `json:"api_key"`
}

func (s *Server) handleZoteroSync(w http.ResponseWriter, r *http.Request) {
	proj := projectName(r)

	var body zoteroSyncRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	userID := strings.TrimSpace(body.UserID)
	apiKey := strings.TrimSpace(body.APIKey)
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "zotero: missing user_id"})
		return
	}
	if apiKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "zotero: missing api_key"})
		return
	}

	bibtex, status, err := fetchZoteroBibTeX(r.Context(), userID, apiKey)
	if err != nil {
		// Mirror 401 so the SPA can surface "bad API key" specifically.
		// Everything else collapses to 502 (upstream unreachable /
		// malformed / quota exceeded).
		out := http.StatusBadGateway
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			out = status
		}
		writeJSON(w, out, map[string]string{"error": err.Error()})
		return
	}

	s.events.Publish(eventbus.Event{
		Source: "server", Component: "zotero", Verb: "sync",
		Project: proj,
		Fields:  map[string]any{"user_id": userID, "bytes": len(bibtex)},
	})

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bibtex)
}

// fetchZoteroBibTeX hits the upstream items endpoint with the user's
// API key. Returns the raw BibTeX bytes on success, OR the upstream
// HTTP status + error so the handler can decide how to surface it.
func fetchZoteroBibTeX(ctx context.Context, userID, apiKey string) ([]byte, int, error) {
	base, err := url.Parse(zoteroUpstream)
	if err != nil {
		return nil, 0, fmt.Errorf("zotero: bad upstream URL: %w", err)
	}
	// URL path : /users/<userID>/items
	base.Path = strings.TrimRight(base.Path, "/") + "/users/" + url.PathEscape(userID) + "/items"
	qs := base.Query()
	qs.Set("format", "bibtex")
	// Zotero's default limit is 25 ; we ask for the max page size
	// (100). Pagination across multiple pages is a V0.2 follow-up —
	// the bulk of Zotero libraries fit in one page.
	qs.Set("limit", "100")
	base.RawQuery = qs.Encode()

	// Zotero can be slow on big libraries — 15 s timeout, twice what
	// the DOI / arXiv handlers grant their lighter endpoints.
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return nil, 0, fmt.Errorf("zotero: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("User-Agent", "weft-loom-server/1.0 (https://github.com/openweft/weft-loom-server)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("zotero: upstream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, resp.StatusCode, fmt.Errorf("zotero: upstream rejected API key (401)")
	}
	if resp.StatusCode == http.StatusForbidden {
		return nil, resp.StatusCode, fmt.Errorf("zotero: upstream forbade access (403)")
	}
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, fmt.Errorf("zotero: upstream returned HTTP %d", resp.StatusCode)
	}
	// 2 MiB cap : bibtex entries are ~150 bytes typical, so 2 MiB is
	// ~13k entries — well above any sane personal library.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("zotero: read body: %w", err)
	}
	return body, resp.StatusCode, nil
}
