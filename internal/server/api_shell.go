package server

// api_shell.go — WebSocket handler that spawns a /bin/bash inside the
// project's working directory and pipes its pty over a binary WS
// frame stream. The SPA side (xterm.js + ShellPanel.svelte) is the
// terminal UI.
//
// Wire shape : two binary frame flavours, distinguished by a 1-byte
// type prefix so we don't need a JSON envelope :
//
//   client → server :
//     'i' + payload   stdin (user keystrokes from xterm)
//     'r' + cols(u16) + rows(u16)   resize the pty
//
//   server → client :
//     'o' + payload   stdout / stderr (pty output)
//
// V0.4 wires this through to the compile microVM's shell (talk to
// weft-microvm-agent via gRPC, exec into the workload container).
// For dev mode the pty lives on the loom-server host directly.

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/workspace"
)

// handleShell upgrades the WS, spawns bash with cwd at the project's
// working tree, and pipes the pty in / out the socket. Closes
// everything on either side hanging up.
func (s *Server) handleShell(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.identify(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Authorize : same gate as /sync — the project must list-files
	// for this identity.
	if _, err := s.opts.Projects.ListFiles(r.Context(), ident, projectName(r)); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Workspace routing : if the user has a real workspace VM
	// provisioned (and a NATS broker to reach it), route the shell
	// to NATS exec session instead of spawning a host pty. In dev
	// mode without WEFT_NATS_URL the workspace returns a sentinel
	// that puts us on the host-pty fallback path below.
	vm, vmErr := s.workspaces.Ensure(r.Context(), workspace.Identity{Subject: ident.Subject})
	if vmErr == nil && vm.Conn != nil && vm.Health() != "dev-local-pty" {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "shell", Verb: "routed.nats",
			Project: projectName(r),
			Fields:  map[string]any{"vm_id": vm.VMID, "subject": ident.Subject},
		})
		if err := relayShellToNATS(r.Context(), conn, vm, projectName(r), s.events); err != nil {
			// Surface to xterm + loom-doctor, then fall through to
			// the host pty path so dev-mode shells keep working when
			// the agent isn't reachable.
			_ = conn.Write(r.Context(), websocket.MessageText, []byte(
				"info: NATS exec relay failed ("+err.Error()+") — falling back to host pty\r\n",
			))
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "shell", Verb: "nats.fallback",
				Level:   "warn",
				Project: projectName(r),
				Fields:  map[string]any{"vm_id": vm.VMID, "err": err.Error()},
			})
		} else {
			// NATS relay handled the entire session ; we're done.
			return
		}
	}
	workDir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		_ = conn.Write(r.Context(), websocket.MessageText, []byte("error: "+err.Error()))
		return
	}
	if _, err := os.Stat(workDir); err != nil {
		// Create the working dir on-demand so a fresh project starts
		// the shell in a usable place.
		_ = os.MkdirAll(workDir, 0o755)
	}

	shell := os.Getenv("WEFT_LOOM_SHELL")
	if shell == "" {
		if _, err := exec.LookPath("bash"); err == nil {
			shell = "bash"
		} else {
			shell = "sh"
		}
	}

	cmd := exec.CommandContext(r.Context(), shell)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"PS1=loom:"+filepath.Base(workDir)+"$ ",
	)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		_ = conn.Write(r.Context(), websocket.MessageText, []byte("error: pty start : "+err.Error()))
		return
	}
	defer func() {
		_ = ptmx.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	if s.opts.Logger != nil {
		s.opts.Logger.Info("shell.spawned", "project", projectName(r), "workdir", workDir, "shell", shell, "pid", cmd.Process.Pid)
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "shell", Verb: "spawned",
		Project: projectName(r),
		Fields: map[string]any{
			"shell": shell, "workdir": workDir, "pid": cmd.Process.Pid,
		},
	})

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// pty → ws : every chunk read from the pty is sent as a single
	// binary frame prefixed with 'o'.
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				frame := append([]byte{'o'}, buf[:n]...)
				if werr := conn.Write(ctx, websocket.MessageBinary, frame); werr != nil {
					cancel()
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) && s.opts.Logger != nil {
					s.opts.Logger.Info("shell.pty.read.err", "err", err.Error())
				}
				cancel()
				return
			}
		}
	}()

	// ws → pty : decode the type byte and dispatch.
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if len(payload) == 0 {
			continue
		}
		switch payload[0] {
		case 'i':
			if _, werr := ptmx.Write(payload[1:]); werr != nil {
				return
			}
		case 'r':
			if len(payload) >= 5 {
				cols := binary.BigEndian.Uint16(payload[1:3])
				rows := binary.BigEndian.Uint16(payload[3:5])
				_ = pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
			}
		}
	}
}
