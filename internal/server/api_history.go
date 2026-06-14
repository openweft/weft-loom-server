package server

// api_history.go : REST surface for per-file change history.
//
//   GET  /api/projects/{name}/history?file=<path>
//        → { entries: [{ ts, author, size }, ...] }  newest first
//
//   GET  /api/projects/{name}/history/snapshot?file=<path>&at=<rfc3339>
//        → { ts, author, size, content }
//
//   POST /api/projects/{name}/history/restore
//        body : { file: "...", at: "rfc3339" }
//        → 204 No Content  (the file on disk now matches the snapshot)
//
// The hook is invoked from handleWriteFile after every successful
// write ; the Store debounces so quick bursts collapse to one entry.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/history"
)

// snapshotAfterWrite is invoked from handleWriteFile. Best-effort —
// any error is logged via eventbus but never bubbled to the client
// (history shouldn't break the write path).
func (s *Server) snapshotAfterWrite(ident auth.Identity, project, file string, content []byte) {
	if s.history == nil {
		return
	}
	dir, err := s.projectWorkingDir(ident, project)
	if err != nil || dir == "" {
		return
	}
	ok, err := s.history.Append(dir, file, ident.Subject, content)
	if err != nil {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "history", Verb: "snapshot.error",
			Level:  "warn", Project: project,
			Fields: map[string]any{"file": file, "err": err.Error()},
		})
		return
	}
	if ok {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "history", Verb: "snapshot.write",
			Project: project,
			Fields:  map[string]any{"file": file, "bytes": len(content)},
		})
	}
}

func (s *Server) handleHistoryList(w http.ResponseWriter, r *http.Request) {
	if s.history == nil {
		writeJSON(w, http.StatusOK, map[string]any{"entries": []any{}})
		return
	}
	ident, _ := auth.IdentityFrom(r.Context())
	file := r.URL.Query().Get("file")
	if file == "" {
		http.Error(w, "file query param required", http.StatusBadRequest)
		return
	}
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"entries": []any{}})
		return
	}
	entries, err := s.history.List(dir, file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if entries == nil {
		entries = []history.Entry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) handleHistorySnapshot(w http.ResponseWriter, r *http.Request) {
	if s.history == nil {
		http.Error(w, "history disabled", http.StatusNotFound)
		return
	}
	ident, _ := auth.IdentityFrom(r.Context())
	file := r.URL.Query().Get("file")
	atStr := r.URL.Query().Get("at")
	if file == "" || atStr == "" {
		http.Error(w, "file + at query params required", http.StatusBadRequest)
		return
	}
	at, err := time.Parse(time.RFC3339Nano, atStr)
	if err != nil {
		at, err = time.Parse(time.RFC3339, atStr)
	}
	if err != nil {
		http.Error(w, "at must be RFC3339 timestamp", http.StatusBadRequest)
		return
	}
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		http.Error(w, "project lookup failed", http.StatusNotFound)
		return
	}
	entry, err := s.history.Snapshot(dir, file, at)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleHistoryRestore(w http.ResponseWriter, r *http.Request) {
	if s.history == nil {
		http.Error(w, "history disabled", http.StatusNotFound)
		return
	}
	ident, _ := auth.IdentityFrom(r.Context())
	var body struct {
		File string `json:"file"`
		At   string `json:"at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.File == "" || body.At == "" {
		http.Error(w, "file + at required", http.StatusBadRequest)
		return
	}
	at, err := time.Parse(time.RFC3339Nano, body.At)
	if err != nil {
		at, err = time.Parse(time.RFC3339, body.At)
	}
	if err != nil {
		http.Error(w, "at must be RFC3339 timestamp", http.StatusBadRequest)
		return
	}
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		http.Error(w, "project lookup failed", http.StatusNotFound)
		return
	}
	entry, err := s.history.Snapshot(dir, body.File, at)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	// Restore = write the snapshot's content back to the live file.
	if werr := s.opts.Projects.WriteFile(
		r.Context(), ident, projectName(r), body.File,
		strings.NewReader(entry.Content),
	); werr != nil {
		http.Error(w, werr.Error(), http.StatusInternalServerError)
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "history", Verb: "restore",
		Project: projectName(r),
		Fields: map[string]any{
			"file":   body.File,
			"to":    entry.TS.Format(time.RFC3339Nano),
			"author": ident.Subject,
		},
	})
	w.WriteHeader(http.StatusNoContent)
}

// ensure the package import isn't reported unused when history is nil.
var _ = errors.New
