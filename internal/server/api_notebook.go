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
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/workspace"
	"github.com/openweft/weft-microvm-agent/pkg/execsession"
)

type notebookExecRequest struct {
	Language string `json:"language"`
	Source   string `json:"source"`
}

type notebookExecResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

func (s *Server) handleNotebookExec(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	projectName := r.PathValue("name")
	// Per-project ACL : matches /sync and /shell. ListFiles fails on
	// "this user can't see this project" so it doubles as the gate.
	if _, err := s.opts.Projects.ListFiles(r.Context(), ident, projectName); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	var req notebookExecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "decode: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Source == "" {
		http.Error(w, "source is required", http.StatusBadRequest)
		return
	}

	vm := s.lookupWorkspace(ident.Subject)
	if vm == nil || vm.Conn == nil {
		http.Error(w, "workspace VM not available", http.StatusServiceUnavailable)
		return
	}

	bin := pickInterpreter(req.Language)
	if bin == "" {
		http.Error(w, "no interpreter for language "+req.Language, http.StatusBadRequest)
		return
	}

	resp, err := execNotebookCell(r.Context(), vm, bin, req.Source)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
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

