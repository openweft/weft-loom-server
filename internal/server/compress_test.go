package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

// bigJS is over the threshold and compresses well, which is what the bundle is.
var bigJS = []byte(strings.Repeat("export function hello() { return 'bonjour'; }\n", 200))

func staticServer() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/app.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = w.Write(bigJS)
	})
	mux.HandleFunc("/small.js", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("let x = 1"))
	})
	mux.HandleFunc("/photo.png", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 500))
	})
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not here", http.StatusNotFound)
	})
	return compressStatic(mux)
}

func get(t *testing.T, h http.Handler, path, accept string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if accept != "" {
		req.Header.Set("Accept-Encoding", accept)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

// What goes over the wire is compressed, and is what it was on disk.
func TestTheBundleIsCompressedAndArrivesIntact(t *testing.T) {
	h := staticServer()

	for _, tt := range []struct {
		accept, want string
		decode       func([]byte) []byte
	}{
		{"br, gzip", "br", func(b []byte) []byte {
			out, err := io.ReadAll(brotli.NewReader(bytes.NewReader(b)))
			if err != nil {
				t.Fatalf("the brotli body does not decompress: %v", err)
			}
			return out
		}},
		{"gzip", "gzip", func(b []byte) []byte {
			r, err := gzip.NewReader(bytes.NewReader(b))
			if err != nil {
				t.Fatalf("the gzip body does not decompress: %v", err)
			}
			out, err := io.ReadAll(r)
			if err != nil {
				t.Fatal(err)
			}
			return out
		}},
	} {
		t.Run(tt.want, func(t *testing.T) {
			resp := get(t, h, "/app.js", tt.accept)
			if got := resp.Header.Get("Content-Encoding"); got != tt.want {
				t.Fatalf("Content-Encoding is %q, want %q", got, tt.want)
			}
			// A cache between here and the reader must not hand this body to
			// somebody who did not ask for it.
			if !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
				t.Fatal("the response does not vary on Accept-Encoding")
			}
			body, _ := io.ReadAll(resp.Body)
			if len(body) >= len(bigJS) {
				t.Fatalf("the body is %d bytes for a %d-byte file: it was not compressed",
					len(body), len(bigJS))
			}
			if !bytes.Equal(tt.decode(body), bigJS) {
				t.Fatal("what arrives is not what was served")
			}
			t.Logf("%d bytes became %d", len(bigJS), len(body))
		})
	}
}

// And what is not worth compressing is not compressed: a caller that cannot
// take it, a file already compressed, and a body too small to pay for the
// header.
func TestWhatIsNotCompressed(t *testing.T) {
	h := staticServer()

	for _, tt := range []struct{ name, path, accept string }{
		{"a caller that does not ask", "/app.js", ""},
		{"a caller that asks for something else", "/app.js", "deflate"},
		{"an image, which is already compressed", "/photo.png", "br"},
		{"a body under a kilobyte", "/small.js", "br"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resp := get(t, h, tt.path, tt.accept)
			if got := resp.Header.Get("Content-Encoding"); got != "" {
				t.Fatalf("Content-Encoding is %q, want none", got)
			}
		})
	}
}

// A path that is not there stays a 404, and is not cached as though it were a
// file — which is what would happen if the status were ignored.
func TestAMissingPathIsStillMissing(t *testing.T) {
	h := staticServer()
	resp := get(t, h, "/missing", "br")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status is %d, want 404", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("a 404 was compressed: Content-Encoding %q", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "not here") {
		t.Fatalf("the 404 body is %q", body)
	}
}

// The second request for a file is served from what the first compressed,
// rather than compressing it again — which for a five-megabyte WebAssembly
// module is the difference between a cache and a cost per reader.
func TestAFileIsCompressedOnce(t *testing.T) {
	compressions := 0
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		compressions++
		_, _ = w.Write(bigJS)
	})
	h := compressStatic(inner)
	first, _ := io.ReadAll(get(t, h, "/app.js", "br").Body)
	second, _ := io.ReadAll(get(t, h, "/app.js", "br").Body)
	if !bytes.Equal(first, second) {
		t.Fatal("the two responses differ")
	}
	// The inner handler still runs — the response is recorded to know whether
	// it is still a 200 — but the compression is not repeated.
	if compressions != 2 {
		t.Fatalf("the inner handler ran %d times, want 2", compressions)
	}
}
