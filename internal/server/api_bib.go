package server

// api_bib.go — huma mount for the 3 bibliographic endpoints :
//
//   POST /api/projects/{name}/bib/from-doi   DOI → BibTeX import
//   POST /api/projects/{name}/zotero/sync    Zotero library relay
//   GET  /api/arxiv/search                   arXiv Atom proxy
//
// Migrated from raw mux to huma so the SPA picks up typed
// definitions in api.gen.ts. Wire compat with the legacy stdlib
// handlers is preserved verbatim — the V0.x SPA build expects :
//
//   - DOI : JSON `{entry, target, appended}` on 200 ; `{error}`
//     envelope on 4xx/5xx (NOT huma's RFC 9457 problem+json shape).
//   - Zotero : raw BibTeX bytes on 200 with Content-Type text/plain ;
//     legacy `{error}` envelope on failure.
//   - arXiv : `{entries: [...]}` on 200 ; legacy `{error}` envelope
//     on failure.
//
// To keep the legacy envelopes we marshal Body []byte ourselves
// rather than returning huma.Error*Models (which would emit
// application/problem+json with {detail} instead of {error}).

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// bibRawOutput is the shared output shape for the 3 endpoints. We
// build the body bytes ourselves so the wire envelope is exactly
// what the legacy raw handlers emitted (avoiding huma's RFC 9457
// problem+json error model).
type bibRawOutput struct {
	Status      int
	ContentType string `header:"Content-Type"`
	Body        []byte
}

// bibErr encodes the legacy `{error: "..."}` envelope at the given
// HTTP status code. Keeps wire compat with the V0.x SPA + the
// existing test assertions that decode into map[string]string.
func bibErr(status int, msg string) *bibRawOutput {
	body, _ := json.Marshal(map[string]string{"error": msg})
	return &bibRawOutput{
		Status:      status,
		ContentType: "application/json",
		Body:        body,
	}
}

// bibJSON encodes the given value as JSON 200 with the legacy
// content-type. Mirror of writeJSON for the huma output path.
func bibJSON(v any) *bibRawOutput {
	body, _ := json.Marshal(v)
	return &bibRawOutput{
		Status:      200,
		ContentType: "application/json",
		Body:        body,
	}
}

// --- DOI → BibTeX -----------------------------------------------------

type doiToBibInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		DOI    string `json:"doi" doc:"DOI in bare form (10.NNNN/suffix) or as a doi.org URL"`
		Target string `json:"target,omitempty" doc:"Optional target .bib file ; defaults to the first .bib in the project or refs.bib"`
	}
}

// --- Zotero sync ------------------------------------------------------

type zoteroSyncInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		UserID string `json:"user_id" doc:"Numeric Zotero user ID (from zotero.org/settings/keys)"`
		APIKey string `json:"api_key" doc:"Zotero API key with library:read permission"`
		Target string `json:"target,omitempty" doc:"Reserved for future use ; current API streams the raw BibTeX back to the client"`
	}
}

// --- arXiv search -----------------------------------------------------

type arxivSearchInput struct {
	Q   string `query:"q" doc:"Search query (passed to arXiv as all:<q>)"`
	Max int    `query:"max,omitempty" doc:"Max results (default 10, capped 50)"`
}

// mountBibAPI registers the 3 bibliographic endpoints on the huma
// API. Each handler reproduces the legacy raw-mux behaviour byte
// for byte ; see api_bib.go header for the contract.
func mountBibAPI(api huma.API, s *Server) {
	// Cap DOI / arXiv / Zotero at the shared externalProxyLimiter so
	// a runaway client can't fan us out into a DDoS against doi.org
	// / arxiv.org / api.zotero.org. The bucket is keyed per identity
	// so one user's spam doesn't starve another.
	var proxyMiddlewares huma.Middlewares
	if s != nil && s.externalProxyLimiter.enabled() {
		proxyMiddlewares = huma.Middlewares{s.humaRateLimit(s.externalProxyLimiter)}
	}
	huma.Register(api, huma.Operation{
		OperationID: "bib-from-doi",
		Method:      "POST",
		Path:        "/api/projects/{name}/bib/from-doi",
		Summary:     "Import a BibTeX entry from a DOI",
		Description: "Resolves a DOI through doi.org's content-negotiation API + appends the returned BibTeX to the target .bib (refs.bib by default).",
		Tags:        []string{"bibliography"},
		Middlewares: proxyMiddlewares,
	}, func(ctx context.Context, in *doiToBibInput) (*bibRawOutput, error) {
		if s == nil {
			return bibErr(500, "server not initialised"), nil
		}
		ident, _ := auth.IdentityFrom(ctx)

		doi, ok := extractDOI(in.Body.DOI)
		if !ok {
			return bibErr(400, "doi: not a valid DOI (expected 10.NNNN/suffix or a doi.org URL)"), nil
		}
		entry, err := resolveDOIToBibTeX(ctx, doi)
		if err != nil {
			return bibErr(502, err.Error()), nil
		}
		target := s.pickTargetBib(ctx, ident, in.Project, in.Body.Target)
		// Defence in depth : never write into the server-side sidecar
		// namespace from user-supplied target paths. The .bib suffix
		// check in pickTargetBib bounds the shape, but the path can
		// still be .weft-loom/x.bib.
		if isInternalPath(target) {
			return nil, huma.Error403Forbidden("target path is reserved")
		}

		// Append to (or create) the target .bib. We don't dedupe —
		// the user may legitimately have two entries for the same
		// DOI in different bibliographies, and dedup against an
		// arbitrary citation key is brittle.
		var combined []byte
		existing, err := s.opts.Projects.ReadFile(ctx, ident, in.Project, target)
		if err == nil {
			buf, _ := io.ReadAll(existing)
			_ = existing.Close()
			combined = buf
			if len(combined) > 0 && !bytes.HasSuffix(combined, []byte("\n")) {
				combined = append(combined, '\n')
			}
		}
		combined = append(combined, []byte(entry)...)

		if werr := s.opts.Projects.WriteFile(ctx, ident, in.Project, target, bytes.NewReader(combined)); werr != nil {
			return bibErr(500, "write: "+werr.Error()), nil
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "doi", Verb: "import",
			Project: in.Project,
			Fields:  map[string]any{"doi": doi, "target": target, "bytes": len(entry)},
		})
		return bibJSON(map[string]any{
			"entry":    entry,
			"target":   target,
			"appended": true,
		}), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "zotero-sync",
		Method:      "POST",
		Path:        "/api/projects/{name}/zotero/sync",
		Summary:     "Relay a Zotero library export as BibTeX",
		Description: "Hits api.zotero.org/users/<id>/items?format=bibtex with the caller-supplied API key + streams the raw BibTeX bytes back. Response Content-Type is text/plain ; the SPA appends the result to refs.bib via the file API.",
		Tags:        []string{"bibliography"},
		Middlewares: proxyMiddlewares,
	}, func(ctx context.Context, in *zoteroSyncInput) (*bibRawOutput, error) {
		userID := strings.TrimSpace(in.Body.UserID)
		apiKey := strings.TrimSpace(in.Body.APIKey)
		if userID == "" {
			return bibErr(400, "zotero: missing user_id"), nil
		}
		if apiKey == "" {
			return bibErr(400, "zotero: missing api_key"), nil
		}

		bibtex, status, err := fetchZoteroBibTeX(ctx, userID, apiKey)
		if err != nil {
			// Mirror 401/403 so the SPA can surface "bad API key"
			// specifically. Everything else collapses to 502.
			out := 502
			if status == 401 || status == 403 {
				out = status
			}
			return bibErr(out, err.Error()), nil
		}

		if s != nil {
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "zotero", Verb: "sync",
				Project: in.Project,
				Fields:  map[string]any{"user_id": userID, "bytes": len(bibtex)},
			})
		}

		return &bibRawOutput{
			Status:      200,
			ContentType: "text/plain; charset=utf-8",
			Body:        bibtex,
		}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "arxiv-search",
		Method:      "GET",
		Path:        "/api/arxiv/search",
		Summary:     "Search arXiv.org",
		Description: "Server-side proxy for arXiv's Atom-XML query API. Parses the upstream feed + returns a compact JSON envelope so the SPA doesn't pull a full XML parser into the bundle.",
		Tags:        []string{"bibliography"},
		Middlewares: proxyMiddlewares,
	}, func(ctx context.Context, in *arxivSearchInput) (*bibRawOutput, error) {
		q := strings.TrimSpace(in.Q)
		if q == "" {
			return bibErr(400, "arxiv: missing q parameter"), nil
		}
		maxResults := 10
		if in.Max > 0 && in.Max <= 50 {
			maxResults = in.Max
		}
		res, err := arxivSearch(ctx, q, maxResults)
		if err != nil {
			return bibErr(502, err.Error()), nil
		}
		return bibJSON(res), nil
	})
}
