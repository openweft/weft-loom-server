package server

// api_chat.go — POST /api/projects/{name}/chat (legacy JSON stub) +
// POST /api/projects/{name}/ai/chat (streaming SSE wired to a real
// provider). The streaming surface picks a provider at request time :
//
//   1. Ollama at http://127.0.0.1:11434 if reachable (local, free).
//   2. Anthropic Claude when ANTHROPIC_API_KEY is set.
//   3. Otherwise a 503 with a friendly stub reply so the SPA can
//      render an "AI provider not configured" hint.
//
// Wire shape :
//   request  : { messages:[{role,content}], file?, file_content? }
//   response : SSE stream of `data: <token>\n\n` chunks, terminated
//              with `event: done\ndata: {}\n\n`. Errors arrive as
//              `event: error\ndata: <msg>\n\n` then connection close.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Messages    []chatMessage `json:"messages"`
	File        string        `json:"file"`
	FileContent string        `json:"file_content"`
}

type chatResponse struct {
	Reply string `json:"reply"`
	Model string `json:"model,omitempty"`
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Messages) == 0 {
		writeJSON(w, http.StatusOK, chatResponse{
			Reply: "I didn't catch a message — try asking again.",
		})
		return
	}
	last := req.Messages[len(req.Messages)-1].Content
	reply := stubReply(last, req.File, req.FileContent)
	writeJSON(w, http.StatusOK, chatResponse{
		Reply: reply,
		Model: "stub-v0",
	})
}

// handleAIChat is the streaming SSE companion to handleChat. Picks
// a provider, then either streams tokens or returns 503 with a stub
// payload so the SPA always renders something useful.
func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Messages) == 0 {
		http.Error(w, "no messages", http.StatusBadRequest)
		return
	}

	// Provider selection. Ollama first (local, free, no key), then
	// Anthropic (if a key is configured), then the 503 stub.
	prov := pickAIProvider(r.Context())
	switch prov {
	case "ollama":
		streamOllama(w, r, req)
	case "anthropic":
		streamAnthropic(w, r, req)
	default:
		// 503 + a stub JSON payload (NOT SSE) so the frontend's
		// EventSource sees a hard failure and falls back to the
		// "provider not configured" message it ships with.
		last := req.Messages[len(req.Messages)-1].Content
		stub := stubReply(last, req.File, req.FileContent)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":    "AI provider not configured",
			"provider": "none",
			"hint":     "Install Ollama at http://127.0.0.1:11434 OR set ANTHROPIC_API_KEY",
			"reply":    stub,
		})
	}
}

// pickAIProvider checks the environment in priority order and returns
// the provider name ("ollama" / "anthropic" / ""). Empty = caller
// should serve the stub 503.
func pickAIProvider(ctx context.Context) string {
	if v := os.Getenv("WEFT_LOOM_AI_PROVIDER"); v != "" {
		// Operator override (also useful in tests : force the stub
		// path even on a host where Ollama happens to be running).
		switch v {
		case "ollama", "anthropic", "none", "stub":
			if v == "ollama" || v == "anthropic" {
				return v
			}
			return ""
		}
	}
	if ollamaReachable(ctx) {
		return "ollama"
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		return "anthropic"
	}
	return ""
}

// ollamaReachable probes the local Ollama daemon with a tight
// timeout — must NOT block the request when Ollama isn't installed.
func ollamaReachable(ctx context.Context) bool {
	cctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, ollamaBaseURL()+"/api/tags", nil)
	if err != nil {
		return false
	}
	cli := &http.Client{Timeout: 250 * time.Millisecond}
	resp, err := cli.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func ollamaBaseURL() string {
	if v := os.Getenv("OLLAMA_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://127.0.0.1:11434"
}

func ollamaModel() string {
	if v := os.Getenv("OLLAMA_MODEL"); v != "" {
		return v
	}
	return "llama3.2"
}

func anthropicModel() string {
	if v := os.Getenv("ANTHROPIC_MODEL"); v != "" {
		return v
	}
	return "claude-haiku-4-5"
}

// streamOllama proxies the Ollama /api/chat streaming endpoint to
// an SSE stream the SPA EventSource can consume.
func streamOllama(w http.ResponseWriter, r *http.Request, req chatRequest) {
	flusher := sseHeader(w)
	if flusher == nil {
		return
	}
	msgs := buildProviderMessages(req)
	body, _ := json.Marshal(map[string]any{
		"model":    ollamaModel(),
		"messages": msgs,
		"stream":   true,
	})
	hreq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, ollamaBaseURL()+"/api/chat", bytes.NewReader(body))
	if err != nil {
		sseError(w, flusher, "ollama request: "+err.Error())
		return
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(hreq)
	if err != nil {
		sseError(w, flusher, "ollama dial: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		sseError(w, flusher, fmt.Sprintf("ollama HTTP %d: %s", resp.StatusCode, string(b)))
		return
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var chunk struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Done bool `json:"done"`
		}
		if err := json.Unmarshal(line, &chunk); err != nil {
			continue
		}
		if chunk.Message.Content != "" {
			sseData(w, flusher, chunk.Message.Content)
		}
		if chunk.Done {
			break
		}
	}
	sseDone(w, flusher)
}

// streamAnthropic proxies the Anthropic Messages streaming API.
func streamAnthropic(w http.ResponseWriter, r *http.Request, req chatRequest) {
	flusher := sseHeader(w)
	if flusher == nil {
		return
	}
	sys := systemPrompt(req)
	msgs := make([]map[string]string, 0, len(req.Messages))
	for _, m := range req.Messages {
		if m.Role == "system" {
			continue
		}
		msgs = append(msgs, map[string]string{"role": m.Role, "content": m.Content})
	}
	body, _ := json.Marshal(map[string]any{
		"model":      anthropicModel(),
		"max_tokens": 1024,
		"system":     sys,
		"messages":   msgs,
		"stream":     true,
	})
	hreq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		sseError(w, flusher, "anthropic request: "+err.Error())
		return
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("x-api-key", os.Getenv("ANTHROPIC_API_KEY"))
	hreq.Header.Set("anthropic-version", "2023-06-01")
	resp, err := http.DefaultClient.Do(hreq)
	if err != nil {
		sseError(w, flusher, "anthropic dial: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		sseError(w, flusher, fmt.Sprintf("anthropic HTTP %d: %s", resp.StatusCode, string(b)))
		return
	}
	// Anthropic SSE : event: content_block_delta\ndata: {...}\n\n
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			break
		}
		var ev struct {
			Type  string `json:"type"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		}
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}
		if ev.Type == "content_block_delta" && ev.Delta.Text != "" {
			sseData(w, flusher, ev.Delta.Text)
		}
	}
	sseDone(w, flusher)
}

func sseHeader(w http.ResponseWriter) http.Flusher {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil
	}
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return flusher
}

func sseData(w http.ResponseWriter, f http.Flusher, token string) {
	// Encode through JSON so multi-line tokens stay on one SSE
	// data: field and the SPA can JSON.parse() each event payload.
	b, _ := json.Marshal(token)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
	f.Flush()
}

func sseError(w http.ResponseWriter, f http.Flusher, msg string) {
	b, _ := json.Marshal(msg)
	_, _ = fmt.Fprintf(w, "event: error\ndata: %s\n\n", b)
	f.Flush()
}

func sseDone(w http.ResponseWriter, f http.Flusher) {
	_, _ = fmt.Fprintf(w, "event: done\ndata: {}\n\n")
	f.Flush()
}

func systemPrompt(req chatRequest) string {
	if req.File == "" {
		return "You are an assistant inside weft-loom, a collaborative editor."
	}
	content := req.FileContent
	if len(content) > 8000 {
		content = content[:8000]
	}
	return "You are an assistant inside weft-loom. The user is editing " + req.File + ". File content follows :\n```\n" + content + "\n```"
}

func buildProviderMessages(req chatRequest) []map[string]string {
	out := make([]map[string]string, 0, len(req.Messages)+1)
	out = append(out, map[string]string{"role": "system", "content": systemPrompt(req)})
	for _, m := range req.Messages {
		if m.Role == "system" {
			continue
		}
		out = append(out, map[string]string{"role": m.Role, "content": m.Content})
	}
	return out
}

// stubReply gives the user a useful canned answer that demonstrates
// the assistant has access to their file context. Returned both by
// the legacy /chat endpoint AND inside the 503 body the streaming
// /ai/chat endpoint emits when no provider is configured.
func stubReply(question, file, content string) string {
	q := strings.ToLower(question)
	lines := strings.Count(content, "\n") + 1
	bytes := len(content)
	switch {
	case file == "":
		return "No file is currently open. Open one from the sidebar so I can read it."
	case strings.Contains(q, "summari") || strings.Contains(q, "résum"):
		return "Stub : would summarise " + file + " (" + nFmt(lines) + " lines, " + nFmt(bytes) + " bytes).\n\nFirst 200 chars : " + clip(content, 200) + "\n\nTo enable real summaries, install Ollama at http://127.0.0.1:11434 OR set ANTHROPIC_API_KEY."
	case strings.Contains(q, "explain") || strings.Contains(q, "explique"):
		return "Stub : would explain " + file + ".\n\nInstall Ollama at http://127.0.0.1:11434 OR set ANTHROPIC_API_KEY to get real explanations."
	default:
		return "Stub assistant. I see you have " + file + " open (" + nFmt(lines) + " lines).\n\nYou asked : " + clip(question, 100) + "\n\nInstall Ollama at http://127.0.0.1:11434 OR set ANTHROPIC_API_KEY to enable real answers."
	}
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func nFmt(n int) string {
	// Tiny digit-grouper without pulling fmt/strconv chains.
	s := []rune(itoa(n))
	if len(s) <= 3 {
		return string(s)
	}
	out := make([]rune, 0, len(s)+len(s)/3)
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, r)
	}
	return string(out)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
