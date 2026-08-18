package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"

	"github.com/andybalholm/brotli"
)

// compressed wraps a static file handler so that what goes over the wire is
// compressed, and is what it was on disk.
//
// The bundle is not small and one file in it is not small at all: the
// collaborative editing client is WebAssembly, and Go's WebAssembly is five and
// a half megabytes. Measured on the real one:
//
//	                       on disk    gzip    brotli
//	collab.wasm            5 599 858  1 573 829  1 174 520
//
// So a page load was moving five and a half megabytes where one and a
// bit would do, over whatever connection the reader has — and for two
// researchers on different continents, which is what this is for, that is the
// difference between a page that opens and a page somebody gives up on.
//
// # Why here rather than in front
//
// A reverse proxy would do this too, and in a deployment that has one it
// should. This server is also run directly — that is what `weft-loom serve`
// is — and a default that only works behind something else is a default that
// does not work.
//
// # What is compressed, and what is not
//
// Only what compresses. A PDF, a PNG or an already-compressed archive gains
// nothing and costs the time twice, so the list is by extension and short. The
// threshold is a kilobyte: below it the header costs more than the saving.
type compressedFS struct {
	inner http.Handler

	mu     sync.Mutex
	cache  map[string][]byte // path + encoding → the compressed bytes
	budget int               // how much the cache may hold
	held   int
}

// compressible reports whether a path is worth compressing. Text and
// WebAssembly are; everything already compressed is not.
func compressible(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".js", ".mjs", ".css", ".html", ".htm", ".json", ".svg", ".wasm",
		".txt", ".map", ".xml", ".ts", ".md":
		return true
	}
	return false
}

// compressStatic wraps a handler. The cache is bounded because the bundle is
// known and small — a few dozen files — but a server should not be made to hold
// whatever it is asked for.
func compressStatic(inner http.Handler) http.Handler {
	return &compressedFS{inner: inner, cache: map[string][]byte{}, budget: 64 << 20}
}

func (c *compressedFS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	enc := chooseEncoding(r.Header.Get("Accept-Encoding"))
	if enc == "" || !compressible(r.URL.Path) {
		c.inner.ServeHTTP(w, r)
		return
	}

	// The response as it stands, so that its headers and its bytes are the
	// ones the inner handler chose — including the 404 it serves for a path
	// that is not there, which must not be cached as though it were a file.
	rec := &recorder{header: http.Header{}}
	c.inner.ServeHTTP(rec, r)
	if rec.status != 0 && rec.status != http.StatusOK {
		copyHeader(w.Header(), rec.header)
		w.WriteHeader(rec.status)
		_, _ = w.Write(rec.body.Bytes())
		return
	}
	if rec.body.Len() < 1024 {
		copyHeader(w.Header(), rec.header)
		_, _ = w.Write(rec.body.Bytes())
		return
	}

	key := enc + " " + r.URL.Path
	c.mu.Lock()
	packed, ok := c.cache[key]
	c.mu.Unlock()
	if !ok {
		packed = squeeze(enc, rec.body.Bytes())
		c.mu.Lock()
		if c.held+len(packed) <= c.budget {
			c.cache[key] = packed
			c.held += len(packed)
		}
		c.mu.Unlock()
	}

	h := w.Header()
	copyHeader(h, rec.header)
	h.Set("Content-Encoding", enc)
	// The length is of the compressed body; the recorded one was not.
	h.Del("Content-Length")
	// A cache between here and the reader must not hand a compressed body to
	// something that did not ask for one.
	h.Add("Vary", "Accept-Encoding")
	_, _ = w.Write(packed)
}

// chooseEncoding picks brotli when the caller takes it and gzip otherwise.
// brotli is smaller — 1.17 MB against 1.57 for the WebAssembly client — and
// every browser that runs this has had it for years; gzip is for everything
// else that speaks HTTP.
func chooseEncoding(accept string) string {
	accept = strings.ToLower(accept)
	switch {
	case strings.Contains(accept, "br"):
		return "br"
	case strings.Contains(accept, "gzip"):
		return "gzip"
	}
	return ""
}

func squeeze(enc string, raw []byte) []byte {
	var out bytes.Buffer
	if enc == "br" {
		// Quality 5 rather than 11: this runs once per file per process, but a
		// cold start should not spend half a second on one file, and the
		// difference on a bundle is a few percent.
		w := brotli.NewWriterOptions(&out, brotli.WriterOptions{Quality: 5})
		_, _ = w.Write(raw)
		_ = w.Close()
		return out.Bytes()
	}
	w, _ := gzip.NewWriterLevel(&out, gzip.BestSpeed)
	_, _ = w.Write(raw)
	_ = w.Close()
	return out.Bytes()
}

func copyHeader(dst, src http.Header) {
	for k, vs := range src {
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// recorder holds a response so it can be compressed before it is sent.
type recorder struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (r *recorder) Header() http.Header         { return r.header }
func (r *recorder) WriteHeader(status int)      { r.status = status }
func (r *recorder) Write(b []byte) (int, error) { return r.body.Write(b) }

var _ io.Writer = (*recorder)(nil)
