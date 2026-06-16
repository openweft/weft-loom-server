package server

// api_history.go : REST surface for per-file change history.
//
//   GET  /api/projects/{name}/history?file=<path>
//        → { entries: [{ ts, author, size, label }, ...] }  newest first
//
//   GET  /api/projects/{name}/history/snapshot?file=<path>&at=<rfc3339>
//        → { ts, author, size, content, label }
//
//   GET  /api/projects/{name}/history/diff?file=<path>&from=<rfc3339>&to=<rfc3339|live>
//        → { from, to, summary: {added, removed}, hunks: [{...}] }
//
//   POST /api/projects/{name}/history/label
//        body : { file, at, label }   empty label clears
//        → { at, label }
//
//   POST /api/projects/{name}/history/restore
//        body : { file, at }
//        → 204 No Content
//
// All five operations refuse to operate on .weft-loom/ paths : the
// internal sidecar namespace (owner, sharing.json, ...) must never
// be diffable / restorable since pre-fix snapshots predate the
// privilege-escalation guard in handleWriteFile.
//
// The hook is invoked from handleWriteFile after every successful
// write ; the Store debounces so quick bursts collapse to one entry.

import (
	"context"
	"io"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

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

// parseAtParam accepts an RFC3339 / RFC3339Nano timestamp string. The
// SPA emits ts values verbatim from history.Entry.TS so they're
// always nanosecond precision in practice.
func parseAtParam(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}

// ── huma I/O types ────────────────────────────────────────────────

type historyListInput struct {
	Project string `path:"name" doc:"Project name"`
	File    string `query:"file" doc:"File path relative to the project root"`
}

type historyEntryOut struct {
	TS     time.Time `json:"ts" doc:"RFC3339Nano timestamp"`
	Author string    `json:"author,omitempty"`
	Size   int       `json:"size"`
	Label  string    `json:"label,omitempty"`
}

type historyListOutput struct {
	Body struct {
		Entries []historyEntryOut `json:"entries"`
	}
}

type historySnapshotInput struct {
	Project string `path:"name" doc:"Project name"`
	File    string `query:"file" doc:"File path relative to the project root"`
	At      string `query:"at" doc:"RFC3339 / RFC3339Nano timestamp of the snapshot"`
}

type historySnapshotOutput struct {
	Body history.Entry
}

type historyDiffInput struct {
	Project string `path:"name" doc:"Project name"`
	File    string `query:"file" doc:"File path relative to the project root"`
	From    string `query:"from" doc:"RFC3339 / RFC3339Nano timestamp of the older snapshot"`
	To      string `query:"to" doc:"RFC3339 timestamp of the newer snapshot, or 'live' (default) for the on-disk file"`
}

type historyDiffOutput struct {
	Body struct {
		From    string              `json:"from"`
		To      string              `json:"to"`
		Summary history.DiffSummary `json:"summary"`
		Hunks   []history.Hunk      `json:"hunks"`
	}
}

type historyLabelInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		File  string `json:"file"`
		At    string `json:"at"`
		Label string `json:"label" doc:"New label ; empty clears"`
	}
}

type historyLabelOutput struct {
	Body struct {
		At    time.Time `json:"at"`
		Label string    `json:"label"`
	}
}

type historyRestoreInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		// "_" carries the additionalProperties tag for huma : the
		// previous raw handler used encoding/json which ignored extra
		// fields ; preserve that wire tolerance so old clients that
		// post {file, at, label, ...} keep working.
		_    struct{} `additionalProperties:"true"`
		File string   `json:"file"`
		At   string   `json:"at"`
	}
}

type historyRestoreOutput struct {
	Status int
}

// mountHistoryAPI registers the five history operations on the huma
// API. The auth middleware injects ident into ctx upstream — every
// handler pulls it via auth.IdentityFrom.
func mountHistoryAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "list-history",
		Method:      "GET",
		Path:        "/api/projects/{name}/history",
		Summary:     "List a file's snapshot timeline",
		Description: "Returns the per-file edit history (newest first). Content is elided ; use the snapshot endpoint to fetch a single revision's text. Refuses .weft-loom/ paths (returns an empty list).",
		Tags:        []string{"history"},
	}, func(ctx context.Context, in *historyListInput) (*historyListOutput, error) {
		out := &historyListOutput{}
		out.Body.Entries = []historyEntryOut{}
		if s == nil || s.history == nil {
			return out, nil
		}
		if in.File == "" {
			return nil, huma.Error400BadRequest("file query param required")
		}
		// Defensive : return an empty list rather than 4xx so the SPA
		// HistoryPanel renders cleanly when an internal path slips in.
		if isInternalPath(in.File) {
			return out, nil
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return out, nil
		}
		entries, err := s.history.List(dir, in.File)
		if err != nil {
			return nil, huma.Error500InternalServerError("list history", err)
		}
		for _, e := range entries {
			out.Body.Entries = append(out.Body.Entries, historyEntryOut{
				TS:     e.TS,
				Author: e.Author,
				Size:   e.Size,
				Label:  e.Label,
			})
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-history-snapshot",
		Method:      "GET",
		Path:        "/api/projects/{name}/history/snapshot",
		Summary:     "Fetch one snapshot's full content",
		Tags:        []string{"history"},
	}, func(ctx context.Context, in *historySnapshotInput) (*historySnapshotOutput, error) {
		if s == nil || s.history == nil {
			return nil, huma.Error404NotFound("history disabled")
		}
		if in.File == "" || in.At == "" {
			return nil, huma.Error400BadRequest("file + at query params required")
		}
		if isInternalPath(in.File) {
			return nil, huma.Error404NotFound("not found")
		}
		at, err := parseAtParam(in.At)
		if err != nil {
			return nil, huma.Error400BadRequest("at must be RFC3339 timestamp")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error404NotFound("project lookup failed")
		}
		entry, err := s.history.Snapshot(dir, in.File, at)
		if err != nil {
			return nil, huma.Error404NotFound(err.Error())
		}
		return &historySnapshotOutput{Body: entry}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "diff-history",
		Method:      "GET",
		Path:        "/api/projects/{name}/history/diff",
		Summary:     "Diff two snapshots (or one snapshot vs the live file)",
		Description: "When `to` is omitted or equal to `live`, the right-hand side is the current on-disk file.",
		Tags:        []string{"history"},
	}, func(ctx context.Context, in *historyDiffInput) (*historyDiffOutput, error) {
		if s == nil || s.history == nil {
			return nil, huma.Error404NotFound("history disabled")
		}
		toStr := in.To
		if toStr == "" {
			toStr = "live"
		}
		if in.File == "" || in.From == "" {
			return nil, huma.Error400BadRequest("file + from query params required")
		}
		if isInternalPath(in.File) {
			return nil, huma.Error404NotFound("not found")
		}
		fromTs, ferr := parseAtParam(in.From)
		if ferr != nil {
			return nil, huma.Error400BadRequest("from must be RFC3339 timestamp")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error404NotFound("project lookup failed")
		}
		fromEntry, err := s.history.Snapshot(dir, in.File, fromTs)
		if err != nil {
			return nil, huma.Error404NotFound(err.Error())
		}
		var toContent, toLabel string
		if toStr == "live" {
			body, lerr := s.opts.Projects.ReadFile(ctx, ident, in.Project, in.File)
			if lerr != nil {
				return nil, huma.Error404NotFound("live file unreadable: " + lerr.Error())
			}
			buf, rerr := io.ReadAll(body)
			_ = body.Close()
			if rerr != nil && rerr != io.EOF {
				return nil, huma.Error500InternalServerError("read live file", rerr)
			}
			toContent = string(buf)
			toLabel = "live"
		} else {
			toTs, terr := parseAtParam(toStr)
			if terr != nil {
				return nil, huma.Error400BadRequest("to must be RFC3339 timestamp or 'live'")
			}
			toEntry, terr2 := s.history.Snapshot(dir, in.File, toTs)
			if terr2 != nil {
				return nil, huma.Error404NotFound(terr2.Error())
			}
			toContent = toEntry.Content
			toLabel = toEntry.TS.Format(time.RFC3339Nano)
		}
		hunks := history.DiffLines(fromEntry.Content, toContent)
		summary := history.SummariseDiff(hunks)
		out := &historyDiffOutput{}
		out.Body.From = fromEntry.TS.Format(time.RFC3339Nano)
		out.Body.To = toLabel
		out.Body.Summary = summary
		out.Body.Hunks = hunks
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "set-history-label",
		Method:      "POST",
		Path:        "/api/projects/{name}/history/label",
		Summary:     "Attach / rename / clear a label on a snapshot",
		Description: "Empty `label` clears the existing label.",
		Tags:        []string{"history"},
	}, func(ctx context.Context, in *historyLabelInput) (*historyLabelOutput, error) {
		if s == nil || s.history == nil {
			return nil, huma.Error404NotFound("history disabled")
		}
		if in.Body.File == "" || in.Body.At == "" {
			return nil, huma.Error400BadRequest("file + at required")
		}
		if isInternalPath(in.Body.File) {
			return nil, huma.Error404NotFound("not found")
		}
		at, err := parseAtParam(in.Body.At)
		if err != nil {
			return nil, huma.Error400BadRequest("at must be RFC3339 timestamp")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error404NotFound("project lookup failed")
		}
		const maxLabel = 80
		label := in.Body.Label
		if len(label) > maxLabel {
			label = label[:maxLabel]
		}
		resolved, err := s.history.SetLabel(dir, in.Body.File, at, label)
		if err != nil {
			return nil, huma.Error404NotFound(err.Error())
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "history", Verb: "label.set",
			Project: in.Project,
			Fields: map[string]any{
				"file":  in.Body.File,
				"at":    resolved.Format(time.RFC3339Nano),
				"label": label,
			},
		})
		out := &historyLabelOutput{}
		out.Body.At = resolved
		out.Body.Label = label
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "restore-history",
		Method:        "POST",
		Path:          "/api/projects/{name}/history/restore",
		Summary:       "Restore a file to a prior snapshot",
		Description:   "Writes the snapshot's content back to the live file. Returns 204 on success. Refuses .weft-loom/ paths with 403 — pre-fix snapshots predate the privilege-escalation guard in handleWriteFile.",
		Tags:          []string{"history"},
		DefaultStatus: 204,
	}, func(ctx context.Context, in *historyRestoreInput) (*historyRestoreOutput, error) {
		if s == nil || s.history == nil {
			return nil, huma.Error404NotFound("history disabled")
		}
		if in.Body.File == "" || in.Body.At == "" {
			return nil, huma.Error400BadRequest("file + at required")
		}
		// Refuse restoring into the server-side sidecar namespace —
		// see api_files / api_project_import for the same gate. A pre-
		// fix snapshot of .weft-loom/owner must not be replayable.
		if isInternalPath(in.Body.File) {
			return nil, huma.Error403Forbidden("internal path")
		}
		at, err := parseAtParam(in.Body.At)
		if err != nil {
			return nil, huma.Error400BadRequest("at must be RFC3339 timestamp")
		}
		ident, _ := auth.IdentityFrom(ctx)
		dir, err := s.projectWorkingDir(ident, in.Project)
		if err != nil {
			return nil, huma.Error404NotFound("project lookup failed")
		}
		entry, err := s.history.Snapshot(dir, in.Body.File, at)
		if err != nil {
			return nil, huma.Error404NotFound(err.Error())
		}
		if werr := s.opts.Projects.WriteFile(
			ctx, ident, in.Project, in.Body.File,
			strings.NewReader(entry.Content),
		); werr != nil {
			return nil, huma.Error500InternalServerError("write file", werr)
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "history", Verb: "restore",
			Project: in.Project,
			Fields: map[string]any{
				"file":   in.Body.File,
				"to":     entry.TS.Format(time.RFC3339Nano),
				"author": ident.Subject,
			},
		})
		return &historyRestoreOutput{Status: 204}, nil
	})
}
