package server

// api_arxiv.go — GET /api/arxiv/search?q=<query>&max=<n>
//
// Proxies arXiv.org's public Atom-XML query API. arXiv doesn't send
// CORS headers, so a browser fetch fails ; this handler is the
// SPA-side escape hatch. We parse the Atom payload server-side +
// return a compact JSON envelope so the client doesn't pull a full
// XML parser into the bundle.
//
// Wire shape :
//
//	request  : GET /api/arxiv/search?q=variational+autoencoder&max=10
//	response : { entries: [{ id, title, authors, summary, year, primaryCategory }] }
//	errors   : 400 missing/empty q, 502 upstream unreachable
//
// The upstream URL is held in a package var so the test can point
// it at an httptest.Server without going through the network — same
// shape as the DOI handler's WEFT_LOOM_DOI_STUB but more thorough
// because it exercises the actual Atom parsing path end to end.

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)


// arxivUpstream is the base URL for the arXiv query endpoint. Tests
// flip this to an httptest.Server. Production points at the public
// API.
var arxivUpstream = "http://export.arxiv.org/api/query"

// arxivAtomFeed mirrors the relevant subset of the Atom payload
// arXiv returns. The encoding/xml decoder ignores fields we don't
// declare, so this is forward-compatible with new arXiv fields.
type arxivAtomFeed struct {
	XMLName xml.Name         `xml:"feed"`
	Entries []arxivAtomEntry `xml:"entry"`
}

type arxivAtomEntry struct {
	ID        string            `xml:"id"`
	Title     string            `xml:"title"`
	Summary   string            `xml:"summary"`
	Published string            `xml:"published"`
	Authors   []arxivAtomAuthor `xml:"author"`
	// arxiv:primary_category — the xml package matches on local name
	// when no namespace prefix is declared on the struct tag, so the
	// "arxiv:" prefix is irrelevant here.
	PrimaryCategory arxivAtomCategory `xml:"primary_category"`
}

type arxivAtomAuthor struct {
	Name string `xml:"name"`
}

type arxivAtomCategory struct {
	Term string `xml:"term,attr"`
}

// arxivSearchResult is the JSON shape the SPA consumes.
type arxivSearchResult struct {
	Entries []arxivSearchEntry `json:"entries"`
}

type arxivSearchEntry struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	Authors         []string `json:"authors"`
	Summary         string   `json:"summary"`
	Year            string   `json:"year"`
	PrimaryCategory string   `json:"primaryCategory"`
}

// The HTTP entry point (GET /api/arxiv/search) lives in api_bib.go
// now ; this file carries only the Atom-parsing helpers (arxivSearch
// + the typed arxivSearchResult shape) the huma handler delegates
// into.

// arxivSearch hits the upstream query endpoint + parses the Atom
// response into our JSON shape.
func arxivSearch(ctx context.Context, query string, maxResults int) (*arxivSearchResult, error) {
	u, err := url.Parse(arxivUpstream)
	if err != nil {
		return nil, fmt.Errorf("arxiv: bad upstream URL: %w", err)
	}
	qs := u.Query()
	qs.Set("search_query", "all:"+query)
	qs.Set("max_results", strconv.Itoa(maxResults))
	u.RawQuery = qs.Encode()

	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("arxiv: build request: %w", err)
	}
	req.Header.Set("User-Agent", "weft-loom-server/1.0 (https://github.com/openweft/weft-loom-server)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("arxiv: upstream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("arxiv: upstream returned HTTP %d", resp.StatusCode)
	}
	// arXiv responses for a 50-result page hover around 80 KB ; cap
	// the read at 1 MiB to bound memory + reject obviously malformed
	// payloads.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("arxiv: read body: %w", err)
	}
	var feed arxivAtomFeed
	if err := xml.Unmarshal(body, &feed); err != nil {
		return nil, fmt.Errorf("arxiv: parse atom: %w", err)
	}
	out := &arxivSearchResult{Entries: make([]arxivSearchEntry, 0, len(feed.Entries))}
	for _, e := range feed.Entries {
		out.Entries = append(out.Entries, toArxivSearchEntry(e))
	}
	return out, nil
}

func toArxivSearchEntry(e arxivAtomEntry) arxivSearchEntry {
	authors := make([]string, 0, len(e.Authors))
	for _, a := range e.Authors {
		name := strings.TrimSpace(a.Name)
		if name != "" {
			authors = append(authors, name)
		}
	}
	// Atom <id> is the absolute URL ; we surface just the arXiv ID
	// segment ("2301.04545v1") so the SPA can build BibTeX keys
	// without parsing the URL.
	id := strings.TrimSpace(e.ID)
	if i := strings.LastIndex(id, "/abs/"); i >= 0 {
		id = id[i+len("/abs/"):]
	}
	// arXiv pads <title> + <summary> with leading whitespace + line
	// breaks ; collapse to a single line so the SPA renders cleanly.
	title := collapseWhitespace(e.Title)
	summary := collapseWhitespace(e.Summary)
	year := ""
	if len(e.Published) >= 4 {
		year = e.Published[:4]
	}
	return arxivSearchEntry{
		ID:              id,
		Title:           title,
		Authors:         authors,
		Summary:         summary,
		Year:            year,
		PrimaryCategory: strings.TrimSpace(e.PrimaryCategory.Term),
	}
}

// collapseWhitespace replaces every run of whitespace (spaces, tabs,
// newlines) with a single space + trims the ends. arXiv's Atom
// payload is pretty-printed, so this is what makes the title /
// summary readable in the SPA list.
func collapseWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := true
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	out := b.String()
	return strings.TrimSpace(out)
}

