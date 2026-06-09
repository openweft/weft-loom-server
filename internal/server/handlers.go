package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/coder/websocket"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/ywebsocket"
)

// projectName is the URL path parameter "{name}". A simple wrapper
// for symmetry with how Go 1.22+ handlers read path params.
func projectName(r *http.Request) string { return r.PathValue("name") }
func filePath(r *http.Request) string    { return r.PathValue("path") }
func compileID(r *http.Request) string   { return r.PathValue("id") }

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	rc, err := s.opts.Projects.ReadFile(r.Context(), ident, projectName(r), filePath(r))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = io.Copy(w, rc)
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	defer r.Body.Close()
	if err := s.opts.Projects.WriteFile(r.Context(), ident, projectName(r), filePath(r), r.Body); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	if err := s.opts.Projects.DeleteFile(r.Context(), ident, projectName(r), filePath(r)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCompileStream serves Server-Sent Events for one compile job :
// log lines as they arrive, then a "result" event with the artifact
// metadata (URL / size) on completion.
func (s *Server) handleCompileStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	id := compileID(r)
	events, err := s.opts.Compiler.Stream(r.Context(), id)
	if err != nil {
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
		flusher.Flush()
		return
	}
	for ev := range events {
		body, _ := json.Marshal(ev)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Kind, body)
		flusher.Flush()
	}
}

// handleSync upgrades the HTTP request to a WebSocket and bridges it
// into the y-websocket Hub. roomID = "<project>:default" for V0.1 ;
// future revs scope per-file or per-named-doc.
func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.identify(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Authorize : caller must have access to the project. The Store
	// owns the policy ; ListFiles errs on access denied today.
	if _, err := s.opts.Projects.ListFiles(r.Context(), ident, projectName(r)); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // origin check happens at the reverse-proxy layer
	})
	if err != nil {
		// Accept already wrote the error response.
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	roomID := projectName(r) + ":default"
	connID := ywebsocket.ConnID(ident.Subject + "@" + r.RemoteAddr)
	m := s.hub.Join(roomID, connID)
	defer m.Leave()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	m.LeaveOnContextDone(ctx)

	// Writer goroutine : forward Recv() onto the socket.
	go func() {
		for payload := range m.Recv() {
			if err := conn.Write(ctx, websocket.MessageBinary, payload); err != nil {
				cancel()
				return
			}
		}
	}()

	// Reader loop : every frame from the client becomes a broadcast.
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return
		}
		m.Send(payload)
	}
}
