// Package lsp bridges a WebSocket carrying JSON-RPC LSP messages
// to a language-server subprocess's stdio. Each LSP server gets a
// per-connection process (texlab / gopls / pyright / typescript-
// language-server) keyed by the language id.
//
// Wire shape on the WS :
//
//	server → client : one JSON-RPC object per WS text frame
//	client → server : one JSON-RPC object per WS text frame
//
// The package strips + adds the Content-Length framing on the
// stdio side so the WS payload is the bare JSON, matching what
// the standard CodeMirror LSP clients expect (e.g.
// `codemirror-languageserver`, `@open-rpc/codemirror-lsp`).
//
// Binary resolution : a language id resolves to a binary via the
// Servers map. The server is configurable via env variables :
//
//	WEFT_LOOM_LSP_TEXLAB  — texlab binary path (default: "texlab")
//	WEFT_LOOM_LSP_GOPLS   — gopls binary path  (default: "gopls")
//	WEFT_LOOM_LSP_PYRIGHT — pyright-langserver (default: "pyright-langserver")
//	WEFT_LOOM_LSP_TS      — typescript-language-server (default: "typescript-language-server")
//
// When the binary isn't on $PATH the bridge writes a JSON-RPC
// error response back to the client + closes the WS so the editor
// can surface a single visible failure instead of silently
// dropping completions.
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"sync"

	"github.com/coder/websocket"
)

// LanguageServer describes how to launch one LSP for a given language.
type LanguageServer struct {
	Lang   string   // canonical key passed via URL path : "latex" / "go" / …
	Binary string   // default executable name
	Args   []string // additional CLI arguments
	// EnvOverride : if non-empty + the env var is set, use that path
	// instead of Binary. Lets ops override per-deployment without
	// re-building the image.
	EnvOverride string
}

// Servers is the registry of LSP launchers. Adding a new language
// is a one-line change here ; the handler dispatches by the URL
// path's lang parameter.
var Servers = map[string]LanguageServer{
	"latex":  {Lang: "latex",  Binary: "texlab",                    EnvOverride: "WEFT_LOOM_LSP_TEXLAB"},
	"go":     {Lang: "go",     Binary: "gopls",                     EnvOverride: "WEFT_LOOM_LSP_GOPLS", Args: []string{"serve"}},
	"python": {Lang: "python", Binary: "pyright-langserver",        EnvOverride: "WEFT_LOOM_LSP_PYRIGHT", Args: []string{"--stdio"}},
	"typescript": {Lang: "typescript", Binary: "typescript-language-server", EnvOverride: "WEFT_LOOM_LSP_TS", Args: []string{"--stdio"}},
	"javascript": {Lang: "javascript", Binary: "typescript-language-server", EnvOverride: "WEFT_LOOM_LSP_TS", Args: []string{"--stdio"}},
	"rust":   {Lang: "rust", Binary: "rust-analyzer", EnvOverride: "WEFT_LOOM_LSP_RUSTANALYZER"},
}

// resolveBinary returns the resolved executable path for a language
// or "" if no binary is on $PATH. Env override wins.
func (s LanguageServer) resolveBinary() (string, error) {
	if s.EnvOverride != "" {
		if v := os.Getenv(s.EnvOverride); v != "" {
			if _, err := os.Stat(v); err == nil {
				return v, nil
			}
		}
	}
	bin, err := exec.LookPath(s.Binary)
	if err != nil {
		return "", err
	}
	return bin, nil
}

// HandleWS upgrades the HTTP request to a WebSocket + spawns the
// per-language LSP. Bidirectional pipe runs until either side
// closes ; the subprocess is killed on WS close.
//
// langKey : the URL path param ("latex", "go", …) extracted by
// the caller's mux. Returning quickly on unknown languages keeps
// the editor's error path clean.
func HandleWS(w http.ResponseWriter, r *http.Request, langKey string, logger *slog.Logger) {
	server, ok := Servers[langKey]
	if !ok {
		http.Error(w, "lsp: unknown language "+langKey, http.StatusNotFound)
		return
	}
	bin, err := server.resolveBinary()
	if err != nil {
		http.Error(w, "lsp: server binary "+server.Binary+" not installed : "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// LSP messages can be larger than the default ; gopls
		// initialize responses easily run past 100 KB.
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusInternalError, "internal error")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, server.Args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"lsp stdin pipe failed"}}`))
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"lsp stdout pipe failed"}}`))
		return
	}
	cmd.Stderr = os.Stderr // surface server stderr in the loom logs
	if err := cmd.Start(); err != nil {
		_ = c.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","error":{"code":-32001,"message":"lsp spawn failed"}}`))
		return
	}
	logger.Info("lsp.spawn", "lang", langKey, "bin", bin, "pid", cmd.Process.Pid)
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		logger.Info("lsp.exit", "lang", langKey, "pid", cmd.Process.Pid)
	}()

	var wg sync.WaitGroup
	wg.Add(2)

	// server → client : read Content-Length-framed JSON messages
	// from the subprocess + forward each as one WS text frame.
	go func() {
		defer wg.Done()
		defer cancel()
		br := bufio.NewReaderSize(stdout, 65536)
		for {
			length, err := readContentLength(br)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					logger.Info("lsp.read.framing.err", "err", err)
				}
				return
			}
			buf := make([]byte, length)
			if _, err := io.ReadFull(br, buf); err != nil {
				logger.Info("lsp.read.body.err", "err", err)
				return
			}
			if err := c.Write(ctx, websocket.MessageText, buf); err != nil {
				logger.Info("lsp.ws.write.err", "err", err)
				return
			}
		}
	}()

	// client → server : pull a WS frame, prepend Content-Length,
	// write to stdin.
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			typ, payload, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			if len(payload) == 0 {
				continue
			}
			frame := []byte("Content-Length: " + strconv.Itoa(len(payload)) + "\r\n\r\n")
			if _, err := stdin.Write(frame); err != nil {
				logger.Info("lsp.stdin.frame.err", "err", err)
				return
			}
			if _, err := stdin.Write(payload); err != nil {
				logger.Info("lsp.stdin.body.err", "err", err)
				return
			}
		}
	}()

	wg.Wait()
	c.Close(websocket.StatusNormalClosure, "")
}

// readContentLength scans the LSP framing header. Each message is :
//
//	Content-Length: <N>\r\n
//	(optional Content-Type: …\r\n)
//	\r\n
//	<JSON bytes>
//
// We accept any header line + only act on Content-Length.
func readContentLength(br *bufio.Reader) (int, error) {
	length := 0
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return 0, err
		}
		if line == "\r\n" || line == "\n" {
			if length == 0 {
				return 0, fmt.Errorf("lsp framing : missing Content-Length")
			}
			return length, nil
		}
		// case-insensitive header parse
		if len(line) > len("Content-Length:") {
			head := line[:len("Content-Length:")]
			if head == "Content-Length:" || head == "content-length:" {
				v := line[len("Content-Length:"):]
				// strip whitespace + CRLF
				start := 0
				for start < len(v) && (v[start] == ' ' || v[start] == '\t') {
					start++
				}
				end := len(v)
				for end > start && (v[end-1] == ' ' || v[end-1] == '\t' || v[end-1] == '\r' || v[end-1] == '\n') {
					end--
				}
				n, err := strconv.Atoi(v[start:end])
				if err != nil {
					return 0, fmt.Errorf("lsp framing : bad Content-Length %q", v[start:end])
				}
				length = n
			}
		}
	}
}

// AvailableLanguages returns the set of language ids whose binary
// is actually resolvable on the host. The client uses this for
// progressive enablement : connecting to /api/lsp/<lang> when the
// host advertises support, and falling back to the regex-based
// autocomplete otherwise.
func AvailableLanguages() []string {
	out := make([]string, 0, len(Servers))
	for k, s := range Servers {
		if _, err := s.resolveBinary(); err == nil {
			out = append(out, k)
		}
	}
	// caller doesn't care about ordering ; sort for stable output.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// EncodeError writes a JSON-RPC error response. Used by the WS
// handler when the bridge can't be set up before the subprocess
// even starts.
func EncodeError(id any, code int, msg string) []byte {
	type errObj struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	type resp struct {
		JSONRPC string `json:"jsonrpc"`
		ID      any    `json:"id"`
		Error   errObj `json:"error"`
	}
	b, _ := json.Marshal(resp{JSONRPC: "2.0", ID: id, Error: errObj{Code: code, Message: msg}})
	return b
}
