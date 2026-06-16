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
	if isInternalPath(file) {
		writeJSON(w, http.StatusOK, map[string]any{"entries": []any{}})
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
	if isInternalPath(file) {
		http.Error(w, "not found", http.StatusNotFound)
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

// handleHistoryDiff returns a line-based diff between two snapshots,
// or between one snapshot and the current live file.
//
//	GET /api/projects/{p}/history/diff
//	     ?file=<path>
//	     &from=<rfc3339>
//	     [&to=<rfc3339>|live]    (default: live)
//
// Response : { from, to, summary: {added, removed}, hunks: [{...}] }
func (s *Server) handleHistoryDiff(w http.ResponseWriter, r *http.Request) {
	if s.history == nil {
		http.Error(w, "history disabled", http.StatusNotFound)
		return
	}
	ident, _ := auth.IdentityFrom(r.Context())
	file := r.URL.Query().Get("file")
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	if toStr == "" {
		toStr = "live"
	}
	if file == "" || fromStr == "" {
		http.Error(w, "file + from query params required", http.StatusBadRequest)
		return
	}
	if isInternalPath(file) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	fromTs, ferr := parseAtParam(fromStr)
	if ferr != nil {
		http.Error(w, "from must be RFC3339 timestamp", http.StatusBadRequest)
		return
	}
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		http.Error(w, "project lookup failed", http.StatusNotFound)
		return
	}
	fromEntry, err := s.history.Snapshot(dir, file, fromTs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	var toContent, toLabel string
	if toStr == "live" {
		// Compare against the file on disk via the project store.
		body, lerr := s.opts.Projects.ReadFile(r.Context(), ident, projectName(r), file)
		if lerr != nil {
			http.Error(w, "live file unreadable: "+lerr.Error(), http.StatusNotFound)
			return
		}
		buf := make([]byte, 0, 4096)
		buf2 := make([]byte, 4096)
		for {
			n, rerr := body.Read(buf2)
			if n > 0 {
				buf = append(buf, buf2[:n]...)
			}
			if rerr != nil {
				break
			}
		}
		_ = body.Close()
		toContent = string(buf)
		toLabel = "live"
	} else {
		toTs, terr := parseAtParam(toStr)
		if terr != nil {
			http.Error(w, "to must be RFC3339 timestamp or 'live'", http.StatusBadRequest)
			return
		}
		toEntry, terr2 := s.history.Snapshot(dir, file, toTs)
		if terr2 != nil {
			http.Error(w, terr2.Error(), http.StatusNotFound)
			return
		}
		toContent = toEntry.Content
		toLabel = toEntry.TS.Format(time.RFC3339Nano)
	}
	hunks := history.DiffLines(fromEntry.Content, toContent)
	summary := history.SummariseDiff(hunks)
	writeJSON(w, http.StatusOK, map[string]any{
		"from":    fromEntry.TS.Format(time.RFC3339Nano),
		"to":      toLabel,
		"summary": summary,
		"hunks":   hunks,
	})
}

// parseAtParam accepts an RFC3339 / RFC3339Nano timestamp string. The
// SPA emits ts values verbatim from history.Entry.TS so they're
// always nanosecond precision in practice.
func parseAtParam(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}

// handleHistoryLabel attaches / changes / clears a label on a
// snapshot. Body : { file, at, label }. Empty label clears.
//
//	POST /api/projects/{name}/history/label
//	     { "file":"main.tex", "at":"2026-06-14T12:34:56Z", "label":"v1.0" }
func (s *Server) handleHistoryLabel(w http.ResponseWriter, r *http.Request) {
	if s.history == nil {
		http.Error(w, "history disabled", http.StatusNotFound)
		return
	}
	ident, _ := auth.IdentityFrom(r.Context())
	var body struct {
		File  string `json:"file"`
		At    string `json:"at"`
		Label string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.File == "" || body.At == "" {
		http.Error(w, "file + at required", http.StatusBadRequest)
		return
	}
	if isInternalPath(body.File) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	at, err := parseAtParam(body.At)
	if err != nil {
		http.Error(w, "at must be RFC3339 timestamp", http.StatusBadRequest)
		return
	}
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		http.Error(w, "project lookup failed", http.StatusNotFound)
		return
	}
	// Cap label length to prevent silly payloads.
	const maxLabel = 80
	label := body.Label
	if len(label) > maxLabel {
		label = label[:maxLabel]
	}
	resolved, err := s.history.SetLabel(dir, body.File, at, label)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "history", Verb: "label.set",
		Project: projectName(r),
		Fields: map[string]any{
			"file":  body.File,
			"at":    resolved.Format(time.RFC3339Nano),
			"label": label,
		},
	})
	writeJSON(w, http.StatusOK, map[string]any{"at": resolved, "label": label})
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
	// Refuse restoring into the server-side sidecar namespace —
	// see api_files / api_project_import for the same gate. A pre-
	// fix snapshot of .weft-loom/owner must not be replayable.
	if isInternalPath(body.File) {
		http.Error(w, "internal path", http.StatusForbidden)
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
