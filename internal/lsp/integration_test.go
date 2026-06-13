package lsp

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestBridgeEndToEnd spawns the fake-lsp binary + drives it through
// the WS handler the way the SPA would. Confirms each method shape
// (initialize / completion / hover / definition / didOpen → publish-
// Diagnostics) survives the WS→stdio→WS round-trip.
func TestBridgeEndToEnd(t *testing.T) {
	bin := findFakeLSPBinary(t)
	t.Setenv("WEFT_LOOM_LSP_FAKE", bin)

	// httptest server wrapping HandleWS with `lang=fake`.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, "fake", testLogger(t))
	}))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	send := func(id int, method string, params any) {
		payload := map[string]any{
			"jsonrpc": "2.0", "id": id, "method": method, "params": params,
		}
		b, _ := json.Marshal(payload)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatalf("ws write %s: %v", method, err)
		}
	}
	notify := func(method string, params any) {
		payload := map[string]any{
			"jsonrpc": "2.0", "method": method, "params": params,
		}
		b, _ := json.Marshal(payload)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatalf("ws notify %s: %v", method, err)
		}
	}
	read := func() map[string]any {
		_, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("ws decode: %v ; raw=%s", err, raw)
		}
		return m
	}

	// 1) initialize
	send(1, "initialize", map[string]any{
		"processId": nil,
		"rootUri":   "file:///proj",
		"capabilities": map[string]any{},
	})
	got := read()
	if got["id"] != float64(1) || got["result"] == nil {
		t.Fatalf("initialize: unexpected response: %v", got)
	}
	if res, ok := got["result"].(map[string]any); !ok || res["capabilities"] == nil {
		t.Fatalf("initialize: missing capabilities: %v", got)
	}
	notify("initialized", map[string]any{})

	// 2) didOpen — should produce a publishDiagnostics notification.
	notify("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri": "file:///proj/main.tex", "languageId": "latex",
			"version": 1, "text": "Hello",
		},
	})
	got = read()
	if got["method"] != "textDocument/publishDiagnostics" {
		t.Fatalf("didOpen: expected publishDiagnostics, got %v", got)
	}

	// 3) completion
	send(2, "textDocument/completion", map[string]any{
		"textDocument": map[string]any{"uri": "file:///proj/main.tex"},
		"position":     map[string]int{"line": 0, "character": 3},
	})
	got = read()
	res, ok := got["result"].(map[string]any)
	if !ok {
		t.Fatalf("completion: missing result: %v", got)
	}
	items, ok := res["items"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("completion: expected 2 items, got %v", res["items"])
	}

	// 4) hover
	send(3, "textDocument/hover", map[string]any{
		"textDocument": map[string]any{"uri": "file:///proj/main.tex"},
		"position":     map[string]int{"line": 0, "character": 0},
	})
	got = read()
	hres, ok := got["result"].(map[string]any)
	if !ok {
		t.Fatalf("hover: missing result: %v", got)
	}
	contents, ok := hres["contents"].(map[string]any)
	if !ok || !strings.Contains(toString(contents["value"]), "fake hover") {
		t.Fatalf("hover: missing expected text: %v", hres)
	}

	// 5) definition
	send(4, "textDocument/definition", map[string]any{
		"textDocument": map[string]any{"uri": "file:///proj/main.tex"},
		"position":     map[string]int{"line": 0, "character": 0},
	})
	got = read()
	dres, ok := got["result"].([]any)
	if !ok || len(dres) != 1 {
		t.Fatalf("definition: expected 1 location, got %v", got)
	}
}

func toString(v any) string {
	s, _ := v.(string)
	return s
}

// findFakeLSPBinary locates the fake-lsp binary. Build path priority :
//   1. WEFT_LOOM_LSP_FAKE env var (already-built binary)
//   2. ~/.weft-loom/bin/fake-lsp (the loom-start helper builds here)
//   3. `go build` on-the-fly into a temp file
func findFakeLSPBinary(t *testing.T) string {
	if v := os.Getenv("WEFT_LOOM_LSP_FAKE"); v != "" {
		if st, err := os.Stat(v); err == nil && !st.IsDir() {
			return v
		}
	}
	home, _ := os.UserHomeDir()
	cand := filepath.Join(home, ".weft-loom", "bin", "fake-lsp")
	if st, err := os.Stat(cand); err == nil && !st.IsDir() {
		return cand
	}
	// Build into the test tempdir as a last resort. Slow but
	// hermetic so the test passes on a fresh checkout.
	out := filepath.Join(t.TempDir(), "fake-lsp")
	// We can't go-build from here without a parent path ; cwd is
	// the package dir, so use the relative path to cmd/fake-lsp.
	src := filepath.Join("..", "..", "cmd", "fake-lsp")
	cmd := exec.Command("go", "build", "-o", out, "./"+src)
	if buf, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("fake-lsp build failed (skipping integration test) : %v\n%s", err, buf)
	}
	return out
}

func testLogger(_ *testing.T) *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
