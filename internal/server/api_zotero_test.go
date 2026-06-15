package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeZoteroBib is a representative BibTeX payload Zotero returns
// when ?format=bibtex is requested : two entries, one per line
// group, with the trailing blank line Zotero ships in real responses.
const fakeZoteroBib = `@article{doe2024example,
  title = {An Example Article},
  author = {Doe, Jane},
  year = {2024},
  journal = {Journal of Examples},
}

@book{smith2023thing,
  title = {A Thing About Things},
  author = {Smith, John},
  year = {2023},
  publisher = {Stub Press},
}
`

// withFakeZoteroUpstream swaps zoteroUpstream with the given URL
// for the duration of the test ; restores the previous value on
// cleanup.
func withFakeZoteroUpstream(t *testing.T, u string) {
	t.Helper()
	prev := zoteroUpstream
	zoteroUpstream = u
	t.Cleanup(func() { zoteroUpstream = prev })
}

func TestZoteroSync_RelaysBibTeXBytes(t *testing.T) {
	var capturedAuth string
	var capturedPath string
	var capturedFormat string
	var capturedLimit string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		capturedPath = r.URL.Path
		capturedFormat = r.URL.Query().Get("format")
		capturedLimit = r.URL.Query().Get("limit")
		w.Header().Set("Content-Type", "application/x-bibtex; charset=utf-8")
		_, _ = w.Write([]byte(fakeZoteroBib))
	}))
	defer upstream.Close()
	withFakeZoteroUpstream(t, upstream.URL)

	srv, _ := newTestServer(t)
	defer srv.Close()

	body := strings.NewReader(`{"user_id":"12345","api_key":"abc-secret"}`)
	resp, err := http.Post(srv.URL+"/api/projects/demo/zotero/sync", "application/json", body)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d ; want 200", resp.StatusCode)
	}

	// Content-Type should mark the payload as text — the SPA reads
	// it as text + appends to refs.bib verbatim.
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q ; want text/plain prefix", ct)
	}

	got := new(bytes.Buffer)
	_, _ = got.ReadFrom(resp.Body)
	if got.String() != fakeZoteroBib {
		t.Errorf("body mismatch :\n got %q\nwant %q", got.String(), fakeZoteroBib)
	}

	// Authorization header was set on the upstream request.
	if capturedAuth != "Bearer abc-secret" {
		t.Errorf("upstream Authorization = %q ; want %q", capturedAuth, "Bearer abc-secret")
	}
	// Path includes the user_id under /users/<id>/items.
	if capturedPath != "/users/12345/items" {
		t.Errorf("upstream path = %q ; want %q", capturedPath, "/users/12345/items")
	}
	// We asked for BibTeX explicitly + max page size.
	if capturedFormat != "bibtex" {
		t.Errorf("upstream format = %q ; want %q", capturedFormat, "bibtex")
	}
	if capturedLimit != "100" {
		t.Errorf("upstream limit = %q ; want %q", capturedLimit, "100")
	}
}

func TestZoteroSync_Upstream401Relayed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "invalid api key", http.StatusUnauthorized)
	}))
	defer upstream.Close()
	withFakeZoteroUpstream(t, upstream.URL)

	srv, _ := newTestServer(t)
	defer srv.Close()

	body := strings.NewReader(`{"user_id":"12345","api_key":"wrong"}`)
	resp, err := http.Post(srv.URL+"/api/projects/demo/zotero/sync", "application/json", body)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d ; want 401", resp.StatusCode)
	}
	var errBody map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(errBody["error"], "401") {
		t.Errorf("error = %q ; want substring %q", errBody["error"], "401")
	}
}

func TestZoteroSync_MissingUserID(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	body := strings.NewReader(`{"user_id":"","api_key":"abc"}`)
	resp, err := http.Post(srv.URL+"/api/projects/demo/zotero/sync", "application/json", body)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d ; want 400", resp.StatusCode)
	}
	var errBody map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(errBody["error"], "user_id") {
		t.Errorf("error = %q ; want substring %q", errBody["error"], "user_id")
	}
}

func TestZoteroSync_MissingAPIKey(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	body := strings.NewReader(`{"user_id":"12345","api_key":""}`)
	resp, err := http.Post(srv.URL+"/api/projects/demo/zotero/sync", "application/json", body)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d ; want 400", resp.StatusCode)
	}
	var errBody map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(errBody["error"], "api_key") {
		t.Errorf("error = %q ; want substring %q", errBody["error"], "api_key")
	}
}

func TestZoteroSync_InvalidJSON(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	body := strings.NewReader(`not-json`)
	resp, err := http.Post(srv.URL+"/api/projects/demo/zotero/sync", "application/json", body)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d ; want 400", resp.StatusCode)
	}
}
