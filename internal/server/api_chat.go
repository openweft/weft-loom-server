package server

// api_chat.go — POST /api/projects/{name}/chat handler. V0.3 ships
// stub responses ; future revs route to a configured LLM backend :
//   - Ollama (already in openweft for weft-doctor)
//   - Anthropic Claude (per-cluster key in cluster.hcl)
//   - OpenAI / Azure OpenAI
//
// The wire shape is the same as the OpenAI chat completion API
// (messages[].role + content) so swapping backends is a config-only
// change once the wiring lands.

import (
	"encoding/json"
	"net/http"
	"strings"
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

// stubReply gives the user a useful canned answer that demonstrates
// the assistant has access to their file context. Future LLM wiring
// replaces this with an actual completion.
func stubReply(question, file, content string) string {
	q := strings.ToLower(question)
	lines := strings.Count(content, "\n") + 1
	bytes := len(content)
	switch {
	case file == "":
		return "No file is currently open. Open one from the sidebar so I can read it."
	case strings.Contains(q, "summari") || strings.Contains(q, "résum"):
		return "Stub : would summarise " + file + " (" + nFmt(lines) + " lines, " + nFmt(bytes) + " bytes).\n\nFirst 200 chars : " + clip(content, 200) + "\n\nTo enable real summaries, configure an LLM backend in cluster.hcl (Ollama / Anthropic / OpenAI)."
	case strings.Contains(q, "explain") || strings.Contains(q, "explique"):
		return "Stub : would explain " + file + ".\n\nConfigure an LLM backend to get real explanations. The wiring point is internal/server/api_chat.go — replace stubReply() with a call into the LLM client."
	default:
		return "Stub assistant. I see you have " + file + " open (" + nFmt(lines) + " lines).\n\nYou asked : " + clip(question, 100) + "\n\nTo enable real answers, wire an LLM backend in internal/server/api_chat.go."
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
