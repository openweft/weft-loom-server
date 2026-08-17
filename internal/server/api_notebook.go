package server

// api_notebook.go — endpoints supporting the NotebookEditor's per-cell
// execution. The notebook itself round-trips through the project files
// API (it's just a JSON document on disk) ; this file owns the live
// `run cell` action.
//
// POST /api/projects/{name}/notebook/exec  { language, source }
//   -> { stdout, stderr, exit_code }
//
// Implementation : dispatches the source as a shell command into the
// user's workspace μVM via the same NATS exec channel the compile path
// uses. The wrapper binary is per-language (python/python3, node, go run, …).
// V0.7 swap-in : a real Jupyter kernel running inside the workspace
// + WebSocket connection for streaming / display data.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/workspace"
	"github.com/openweft/weft-microvm-agent/pkg/execsession"
)

type notebookExecRequest struct {
	Language string `json:"language"`
	Source   string `json:"source"`
}

type notebookExecResponse struct {
	Stdout   string `json:"stdout" doc:"Captured stdout from the cell's interpreter."`
	Stderr   string `json:"stderr" doc:"Captured stderr from the cell's interpreter."`
	ExitCode int    `json:"exit_code" doc:"Process exit code ; 0 = success, 124 = our 60 s timeout."`
}

// notebookExecInput is the typed huma wire shape : project name in the
// path + a JSON body carrying the language picker + the cell source.
type notebookExecInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		Language string `json:"language" doc:"Notebook language_info.name (python | go | node | ruby | rust). Defaults to python when unknown."`
		Source   string `json:"source" doc:"Cell source ; passed verbatim to the chosen interpreter via shell quoting."`
	}
}

type notebookExecOutput struct {
	Body notebookExecResponse
}

func mountNotebookAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "notebook-exec",
		Method:      "POST",
		Path:        "/api/projects/{name}/notebook/exec",
		Summary:     "Execute one notebook cell in the workspace μVM",
		Description: "Dispatches the cell source as a shell command into the user's pre-spawned workspace μVM ; the wrapper binary is per-language. Returns captured stdout + stderr + exit code. Hard 60 s timeout so runaway loops don't pin the HTTP connection.",
		Tags:        []string{"notebook"},
	}, func(ctx context.Context, in *notebookExecInput) (*notebookExecOutput, error) {
		out := &notebookExecOutput{}
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)
		// Per-project ACL : matches /collab and /shell. ListFiles fails on
		// "this user can't see this project" so it doubles as the gate.
		if _, err := s.opts.Projects.ListFiles(ctx, ident, in.Project); err != nil {
			return nil, huma.Error403Forbidden("forbidden")
		}

		if in.Body.Source == "" {
			return nil, huma.Error400BadRequest("source is required")
		}

		vm := s.lookupWorkspace(ident.Subject)
		if vm == nil || vm.Conn == nil {
			return nil, huma.Error503ServiceUnavailable("workspace VM not available")
		}

		bin := pickInterpreter(in.Body.Language)
		if bin == "" {
			return nil, huma.Error400BadRequest("no interpreter for language " + in.Body.Language)
		}

		resp, err := execNotebookCell(ctx, vm, bin, in.Body.Source)
		if err != nil {
			return nil, huma.Error500InternalServerError(err.Error())
		}
		out.Body = resp
		return out, nil
	})
}

// pickInterpreter maps a notebook's `language_info.name` to the
// wrapper binary the workspace μVM exposes (apptainer exec into the
// language's OCI sandbox). Empty return = unsupported language.
func pickInterpreter(lang string) string {
	switch strings.ToLower(lang) {
	case "python", "python3", "py":
		return "python3"
	case "go", "golang":
		return "go"
	case "node", "javascript", "js":
		return "node"
	case "ruby", "rb":
		return "ruby"
	case "rust", "rs":
		return "rust"
	}
	// Default to python — by far the most common notebook kernel.
	return "python3"
}

// lookupWorkspace returns the user's pre-spawned workspace VM if the
// registry has one. Wrapped in its own helper so the prod path can
// gate on identity claims without retro-fitting every call site.
func (s *Server) lookupWorkspace(subject string) *workspace.VM {
	if s.workspaces == nil {
		return nil
	}
	vm, err := s.workspaces.Ensure(context.Background(), workspace.Identity{Subject: subject})
	if err != nil {
		return nil
	}
	return vm
}

// execNotebookCell publishes a shell-kind ExecRequest to the workspace
// VM ; the agent forks /bin/sh -c "<bin> -c <src>" and pipes stdout +
// stderr back over `weft.exec.<vmID>.<sid>.out`. We accumulate the
// streams in-memory + return on the exit frame.
func execNotebookCell(ctx context.Context, vm *workspace.VM, bin, src string) (notebookExecResponse, error) {
	sid := newSID()
	outSubject := execsession.SubjectOut(vm.VMID, sid)
	openSubject := execsession.SubjectOpen(vm.VMID)

	var (
		mu       sync.Mutex
		stdout   strings.Builder
		stderr   strings.Builder
		exitVal  uint32
		exited   bool
	)
	done := make(chan struct{})

	sub, err := vm.Conn.Subscribe(outSubject, func(_ string, data []byte) {
		if len(data) == 0 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch data[0] {
		case 'o':
			stdout.Write(data[1:])
		case 'e':
			// Guard against a second 'e' frame from the agent — close(done)
			// twice panics. Serialised under mu so the flag flip + close
			// is atomic w.r.t. the select on <-done in the caller.
			if len(data) >= 5 && !exited {
				exited = true
				exitVal = binary.BigEndian.Uint32(data[1:5])
				close(done)
			}
		}
	})
	if err != nil {
		return notebookExecResponse{}, fmt.Errorf("subscribe out: %w", err)
	}
	defer func() { _ = sub.Unsubscribe() }()

	// Build the command : the apptainer wrapper for the chosen
	// interpreter accepts `-c <source>` (Python convention ; node
	// + ruby + rust also take -c / --eval). Wrap in /bin/sh so we
	// can stuff the source through stdin safely.
	openMsg, err := json.Marshal(execsession.ExecRequest{
		ID: sid,
		Target: execsession.ExecTarget{
			Kind:    "shell",
			Command: []string{"/bin/sh", "-c", bin + " -c " + shellQuote(src)},
			WorkDir: "/workspace",
		},
	})
	if err != nil {
		return notebookExecResponse{}, fmt.Errorf("marshal: %w", err)
	}
	if err := vm.Conn.Publish(openSubject, openMsg); err != nil {
		return notebookExecResponse{}, fmt.Errorf("publish: %w", err)
	}

	// Wait for exit OR a 60-second timeout — cells with infinite
	// loops shouldn't pin the HTTP connection forever.
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		return notebookExecResponse{
			Stderr:   "weft-loom: cell timed out after 60 s",
			ExitCode: 124,
		}, nil
	case <-ctx.Done():
		return notebookExecResponse{}, ctx.Err()
	}

	mu.Lock()
	defer mu.Unlock()
	if !exited {
		return notebookExecResponse{ExitCode: -1, Stderr: "exec did not signal exit"}, nil
	}
	return notebookExecResponse{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: int(int32(exitVal)),
	}, nil
}

// shellQuote produces a single-quoted POSIX shell argument that
// preserves the source byte-for-byte (' becomes '\'').
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// newSID is the same job-id generator the compile path uses ; kept
// local to the notebook file to avoid leaking the internal name.
func newSID() string {
	// 8 random bytes as hex — collision space is plenty for the
	// per-session scope of notebook cell ids.
	var b [8]byte
	for i := range b {
		// time-derived seed is sufficient — these IDs are routing,
		// not security tokens.
		b[i] = byte(time.Now().UnixNano() >> (i * 8))
	}
	return fmt.Sprintf("%x", b)
}

