package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeArxivAtom is a representative arXiv Atom response :
//   - one entry with two authors
//   - whitespace + line breaks in <title>/<summary> (mirrors the real
//     pretty-printed payload)
//   - arxiv:primary_category with a term attribute
const fakeArxivAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2301.04545v1</id>
    <updated>2023-01-12T00:00:00Z</updated>
    <published>2023-01-12T00:00:00Z</published>
    <title>
      A Study of
      Variational Autoencoders
    </title>
    <summary>
      We propose a new
      family of generative models.
    </summary>
    <author><name>Alice Bob</name></author>
    <author><name>Charlie Diaz</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2010.11111v2</id>
    <published>2020-10-22T00:00:00Z</published>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <author><name>Eve Foo</name></author>
    <arxiv:primary_category term="stat.ML"/>
  </entry>
</feed>`

// withFakeArxivUpstream swaps arxivUpstream with the given URL for
// the duration of the test ; restores the previous value on cleanup.
func withFakeArxivUpstream(t *testing.T, u string) {
	t.Helper()
	prev := arxivUpstream
	arxivUpstream = u
	t.Cleanup(func() { arxivUpstream = prev })
}

func TestArxivSearch_ParsesAtomFeed(t *testing.T) {
	var capturedQuery string
	var capturedMax string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.Query().Get("search_query")
		capturedMax = r.URL.Query().Get("max_results")
		w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
		_, _ = w.Write([]byte(fakeArxivAtom))
	}))
	defer upstream.Close()
	withFakeArxivUpstream(t, upstream.URL)

	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/arxiv/search?q=" + url.QueryEscape("variational autoencoder") + "&max=7")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}
	var got arxivSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Entries) != 2 {
		t.Fatalf("entries = %d ; want 2", len(got.Entries))
	}

	// Upstream got the search_query + max_results we asked for.
	if capturedQuery != "all:variational autoencoder" {
		t.Errorf("upstream search_query = %q ; want %q", capturedQuery, "all:variational autoencoder")
	}
	if capturedMax != "7" {
		t.Errorf("upstream max_results = %q ; want %q", capturedMax, "7")
	}

	e0 := got.Entries[0]
	if e0.ID != "2301.04545v1" {
		t.Errorf("entry[0].id = %q ; want %q", e0.ID, "2301.04545v1")
	}
	if e0.Title != "A Study of Variational Autoencoders" {
		t.Errorf("entry[0].title = %q ; want collapsed whitespace", e0.Title)
	}
	if e0.Summary != "We propose a new family of generative models." {
		t.Errorf("entry[0].summary = %q ; want collapsed whitespace", e0.Summary)
	}
	if e0.Year != "2023" {
		t.Errorf("entry[0].year = %q ; want %q", e0.Year, "2023")
	}
	if e0.PrimaryCategory != "cs.LG" {
		t.Errorf("entry[0].primaryCategory = %q ; want %q", e0.PrimaryCategory, "cs.LG")
	}
	wantAuthors := []string{"Alice Bob", "Charlie Diaz"}
	if len(e0.Authors) != len(wantAuthors) {
		t.Fatalf("entry[0].authors = %v ; want %v", e0.Authors, wantAuthors)
	}
	for i, name := range wantAuthors {
		if e0.Authors[i] != name {
			t.Errorf("entry[0].authors[%d] = %q ; want %q", i, e0.Authors[i], name)
		}
	}

	e1 := got.Entries[1]
	if e1.ID != "2010.11111v2" {
		t.Errorf("entry[1].id = %q ; want %q", e1.ID, "2010.11111v2")
	}
	if e1.PrimaryCategory != "stat.ML" {
		t.Errorf("entry[1].primaryCategory = %q ; want %q", e1.PrimaryCategory, "stat.ML")
	}
}

func TestArxivSearch_MissingQuery(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/arxiv/search")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d ; want 400", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(body["error"], "missing q") {
		t.Errorf("error = %q ; want substring %q", body["error"], "missing q")
	}
}

func TestArxivSearch_UpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()
	withFakeArxivUpstream(t, upstream.URL)

	srv, _ := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/arxiv/search?q=anything")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d ; want 502", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(body["error"], "500") {
		t.Errorf("error = %q ; want substring %q", body["error"], "500")
	}
}

func TestArxivSearch_MaxClamp(t *testing.T) {
	var capturedMax string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMax = r.URL.Query().Get("max_results")
		w.Header().Set("Content-Type", "application/atom+xml")
		_, _ = fmt.Fprint(w, `<feed xmlns="http://www.w3.org/2005/Atom"></feed>`)
	}))
	defer upstream.Close()
	withFakeArxivUpstream(t, upstream.URL)

	srv, _ := newTestServer(t)
	defer srv.Close()

	// Out-of-range max falls back to the default (10), not the
	// caller-supplied 9999. Protects upstream from being asked to
	// dump 10k entries per click.
	resp, err := http.Get(srv.URL + "/api/arxiv/search?q=foo&max=9999")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}
	if capturedMax != "10" {
		t.Errorf("upstream max_results = %q ; want fallback %q", capturedMax, "10")
	}
}
