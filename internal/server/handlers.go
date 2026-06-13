package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/coder/websocket"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
	loomlsp "github.com/openweft/weft-loom-server/internal/lsp"
	"github.com/openweft/weft-loom-server/internal/synctex"
	"github.com/openweft/weft-loom-server/internal/workspace"
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
	// Proactive container warmup : when the file extension hints at
	// a compileable artefact (.tex/.md/.go/...) publish the matching
	// tool container into the user's workspace VM containers set so
	// it's already warm when they hit Compile. Idempotent.
	if s.workspaces != nil {
		go func() {
			vm, err := s.workspaces.Ensure(context.Background(), workspace.Identity{Subject: ident.Subject})
			if err != nil || vm == nil {
				return
			}
			s.warmContainerForFile(context.Background(), vm, projectName(r), filePath(r))
		}()
	}
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	defer r.Body.Close()
	if err := s.opts.Projects.WriteFile(r.Context(), ident, projectName(r), filePath(r), r.Body); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// V0.3 : git is the source of truth. Every file write resets the
	// per-project debounce timer ; an idle period of autoPushIdle
	// seconds triggers a background auto-commit + push. Unconfigured
	// projects no-op.
	s.schedulePush(ident, projectName(r))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	if err := s.opts.Projects.DeleteFile(r.Context(), ident, projectName(r), filePath(r)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.schedulePush(ident, projectName(r))
	w.WriteHeader(http.StatusNoContent)
}

// handleCompileArtifact streams the compiled PDF out of the per-job
// scratch dir. compile.Service.Artifact(id) returns the absolute path
// kept in memory for ~30 minutes after the job finishes ; the SPA
// fetches this URL when it wants to display the result inline.
func (s *Server) handleCompileArtifact(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	path, ok := s.opts.Compiler.Artifact(id)
	if !ok {
		http.Error(w, "compile artifact not found or expired", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `inline; filename="output.pdf"`)
	http.ServeFile(w, r, path)
}

// handleLSP : upgrade to WebSocket + bridge it to the per-language
// stdio LSP. Authenticated like the rest of the project API ; the
// lang URL param picks the registered server.
func (s *Server) handleLSP(w http.ResponseWriter, r *http.Request) {
	loomlsp.HandleWS(w, r, r.PathValue("lang"), s.opts.Logger, s.wsAcceptOpts())
}

// handleLSPList : reports which LSP servers are actually resolvable
// on this host so the SPA can enable LSP-backed features
// progressively. Returns { available: ["latex", "go", …] }.
func (s *Server) handleLSPList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"available": loomlsp.AvailableLanguages(),
	})
}

// handleSyncTeX answers SyncTeX queries against the .synctex.gz
// stream pdflatex produced alongside the PDF.
//
//	GET ?source=<file>&line=<n>       → forward  : { page, x, y }
//	GET ?page=<p>&x=<x>&y=<y>         → backward : { source, line }
//
// 404 when there's no synctex file for the given compile id (the
// compile may have failed, used a non-LaTeX path, or the artifact
// expired). 400 when neither query shape is satisfied.
func (s *Server) handleSyncTeX(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	path, ok := s.opts.Compiler.SyncTeXPath(id)
	if !ok {
		http.Error(w, "synctex not found for compile "+id, http.StatusNotFound)
		return
	}
	// Scope Input: paths to this project's working tree so untrusted
	// .synctex.gz content can't leak absolute host paths back to the SPA.
	var parseOpts []synctex.Option
	if ident, ok := auth.IdentityFrom(r.Context()); ok {
		if root, derr := s.projectWorkingDir(ident, projectName(r)); derr == nil && root != "" {
			parseOpts = append(parseOpts, synctex.WithProjectRoot(root))
		}
	}
	f, err := synctex.Parse(path, parseOpts...)
	if err != nil {
		http.Error(w, "synctex parse : "+err.Error(), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	// Forward : source + line.
	if src := q.Get("source"); src != "" {
		line, _ := strconv.Atoi(q.Get("line"))
		rec, found := f.Forward(src, line)
		w.Header().Set("Content-Type", "application/json")
		if !found {
			_ = json.NewEncoder(w).Encode(map[string]any{"found": false})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"found": true,
			"page":  rec.Page,
			"x":     rec.X,
			"y":     rec.Y,
			"line":  rec.Line,
		})
		return
	}
	// Backward : page + x + y.
	if p := q.Get("page"); p != "" {
		page, _ := strconv.Atoi(p)
		x, _ := strconv.Atoi(q.Get("x"))
		y, _ := strconv.Atoi(q.Get("y"))
		src, line, found := f.Backward(page, x, y)
		w.Header().Set("Content-Type", "application/json")
		if !found {
			_ = json.NewEncoder(w).Encode(map[string]any{"found": false})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"found":  true,
			"source": src,
			"line":   line,
		})
		return
	}
	http.Error(w, "synctex requires either source+line (forward) or page+x+y (backward)", http.StatusBadRequest)
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

	conn, err := websocket.Accept(w, r, s.wsAcceptOpts())
	if err != nil {
		// Accept already wrote the error response.
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// roomID uses the URL's room segment so multiple Yjs rooms can
	// coexist under one project (per-file rooms, the test harness's
	// random room names, etc.). Empty → "default" for back-compat
	// with clients that don't pass a room.
	roomSeg := r.PathValue("room")
	if roomSeg == "" {
		roomSeg = "default"
	}
	roomID := projectName(r) + ":" + roomSeg
	connID := ywebsocket.ConnID(ident.Subject + "@" + r.RemoteAddr)
	m := s.hub.Join(roomID, connID)
	defer m.Leave()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	m.LeaveOnContextDone(ctx)

	log := s.opts.Logger
	log.Info("ws.upgraded", "room", roomID, "conn", string(connID), "members", s.hub.MembersCount(roomID))
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "ws", Verb: "upgraded",
		Project: projectName(r),
		Fields: map[string]any{
			"room": roomID, "conn": string(connID),
			"members": s.hub.MembersCount(roomID),
		},
	})

	// Writer goroutine : forward Recv() onto the socket.
	go func() {
		var outBytes, outFrames uint64
		for payload := range m.Recv() {
			outBytes += uint64(len(payload))
			outFrames++
			log.Info("ws.out", "room", roomID, "conn", string(connID), "frame_n", outFrames, "bytes", len(payload))
			if err := conn.Write(ctx, websocket.MessageBinary, payload); err != nil {
				log.Info("ws.write.err", "room", roomID, "conn", string(connID), "out_frames", outFrames, "out_bytes", outBytes, "err", err.Error())
				cancel()
				return
			}
		}
		log.Info("ws.writer.exit", "room", roomID, "conn", string(connID), "out_frames", outFrames, "out_bytes", outBytes)
	}()

	// Reader loop : every frame from the client becomes a broadcast.
	var inBytes, inFrames uint64
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			log.Info("ws.reader.exit", "room", roomID, "conn", string(connID), "in_frames", inFrames, "in_bytes", inBytes, "err", err.Error())
			return
		}
		inBytes += uint64(len(payload))
		inFrames++
		log.Info("ws.in", "room", roomID, "conn", string(connID), "frame_n", inFrames, "bytes", len(payload))
		m.Send(payload)
	}
}
