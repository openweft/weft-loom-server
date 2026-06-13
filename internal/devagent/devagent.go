// Package devagent is the in-process mock of weft-microvm-agent we
// run inside loom-server when no real workspace VM is reachable.
//
// Why : we want the SHELL → NATS → AGENT round-trip to actually work
// in dev mode (the most common path for a contributor on a Mac), not
// just compile-and-pray. The dev agent listens on the same NATS
// subjects the real agent listens on (weft.exec.<vmID>.open + .in)
// and pumps a /bin/bash pty on the loom-server host — so the user
// gets a working shell in their browser without QEMU.
//
// The cost : we lose isolation. The user's shell is on the host,
// not in a sandbox. That's why loom-doctor surfaces a
// "shell.dev.agent" event so the operator can see this isn't the
// production path. Real isolation lands when LocalProvisioner.Ensure
// boots a QEMU + real weft-microvm-agent in the VM.
//
// Pattern : Subscribe(weft.exec.<vmID>.open) → on each open msg,
// spawn pty + subscribe to that session's in subject + publish
// to its out subject. Mirrors pkg/execsession exactly so the wire
// shape is identical to what the real agent would emit.
package devagent

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
	"github.com/nats-io/nats.go"
	execsession "github.com/openweft/weft-microvm-agent/pkg/execsession"
)

// Agent is one running dev agent — bound to a single vmID (the
// sentinel "wl-<sha>" the LocalProvisioner returns). loom-server
// boots one per identity on first Ensure, keeps them around for the
// process lifetime.
type Agent struct {
	nc       *nats.Conn
	vmID     string
	workDir  string
	log      *slog.Logger
	mu       sync.Mutex
	sessions map[string]context.CancelFunc
	openSub  *nats.Subscription
}

// Start subscribes to the agent's open subject + returns the live
// Agent. nc is the loom-server's NATS conn, vmID is the workspace's
// stable handle, workDir is where bash spawns (typically a per-user
// dir under the storage root). The agent shuts down when Close() is
// called or the conn drops.
func Start(nc *nats.Conn, vmID, workDir string, log *slog.Logger) (*Agent, error) {
	if log == nil {
		log = slog.Default()
	}
	a := &Agent{
		nc:       nc,
		vmID:     vmID,
		workDir:  workDir,
		log:      log,
		sessions: map[string]context.CancelFunc{},
	}
	sub, err := nc.Subscribe(execsession.SubjectOpen(vmID), a.handleOpen)
	if err != nil {
		return nil, fmt.Errorf("devagent subscribe open: %w", err)
	}
	a.openSub = sub
	a.log.Info("devagent started", "vm_id", vmID, "work_dir", workDir)
	return a, nil
}

// Close stops the open subscription + cancels every live session.
func (a *Agent) Close() {
	if a.openSub != nil {
		_ = a.openSub.Unsubscribe()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, cancel := range a.sessions {
		cancel()
	}
	a.sessions = map[string]context.CancelFunc{}
}

func (a *Agent) handleOpen(m *nats.Msg) {
	req, err := execsession.DecodeRequest(m.Data)
	if err != nil {
		a.log.Warn("devagent: bad open request", "err", err)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	if prev, ok := a.sessions[req.ID]; ok {
		prev() // replace if the publisher reissued
	}
	a.sessions[req.ID] = cancel
	a.mu.Unlock()
	go a.runSession(ctx, req)
}

// runSession is the pty pump : decoupled from handleOpen so a slow
// open broadcast can't starve subsequent opens.
func (a *Agent) runSession(ctx context.Context, req execsession.ExecRequest) {
	defer func() {
		a.mu.Lock()
		delete(a.sessions, req.ID)
		a.mu.Unlock()
	}()
	cmd, err := buildCommand(req.Target, a.workDir)
	if err != nil {
		a.log.Warn("devagent: build command", "err", err, "sid", req.ID)
		return
	}
	ptmx, err := pty.Start(cmd)
	if err != nil {
		a.log.Warn("devagent: pty start", "err", err, "sid", req.ID)
		return
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()
	if req.InitialCols > 0 && req.InitialRows > 0 {
		_ = pty.Setsize(ptmx, &pty.Winsize{Cols: req.InitialCols, Rows: req.InitialRows})
	}

	outSubject := execsession.SubjectOut(a.vmID, req.ID)
	inSubject := execsession.SubjectIn(a.vmID, req.ID)

	// pty → out
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				frame := append([]byte{'o'}, buf[:n]...)
				_ = a.nc.Publish(outSubject, frame)
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					a.log.Debug("devagent: pty read", "err", err, "sid", req.ID)
				}
				return
			}
		}
	}()

	sub, err := a.nc.Subscribe(inSubject, func(m *nats.Msg) {
		if len(m.Data) == 0 {
			return
		}
		switch m.Data[0] {
		case 'i':
			_, _ = ptmx.Write(m.Data[1:])
		case 'r':
			if len(m.Data) >= 5 {
				cols := binary.BigEndian.Uint16(m.Data[1:3])
				rows := binary.BigEndian.Uint16(m.Data[3:5])
				_ = pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
			}
		case 'x':
			_ = cmd.Process.Kill()
		}
	})
	if err != nil {
		a.log.Warn("devagent: subscribe in", "err", err, "sid", req.ID)
		return
	}
	defer sub.Unsubscribe()

	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()

	select {
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
	case <-done:
	}

	exit := uint32(0)
	if cmd.ProcessState != nil {
		exit = uint32(cmd.ProcessState.ExitCode())
	}
	frame := []byte{'e', 0, 0, 0, 0}
	binary.BigEndian.PutUint32(frame[1:], exit)
	_ = a.nc.Publish(outSubject, frame)
}

func buildCommand(t execsession.ExecTarget, defaultDir string) (*exec.Cmd, error) {
	switch t.Kind {
	case "shell":
		shell := "/bin/bash"
		if _, err := exec.LookPath("bash"); err != nil {
			shell = "/bin/sh"
		}
		c := exec.Command(shell)
		c.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
		c.Dir = pickDir(t.WorkDir, defaultDir)
		return c, nil
	case "exec":
		// The dev agent doesn't have crun ; "exec" against a
		// container name resolves to a host /bin/sh that runs
		// the requested argv. Good enough for compile rewire :
		// the user's `pdflatex` lives on the host PATH in dev.
		argv := append([]string{}, t.Command...)
		argv = append(argv, t.Args...)
		if len(argv) == 0 {
			return nil, fmt.Errorf("devagent: empty command for kind=exec")
		}
		c := exec.Command(argv[0], argv[1:]...)
		c.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
		for k, v := range t.Env {
			c.Env = append(c.Env, k+"="+v)
		}
		c.Dir = pickDir(t.WorkDir, defaultDir)
		return c, nil
	}
	return nil, fmt.Errorf("devagent: unknown kind %q", t.Kind)
}

func pickDir(want, fallback string) string {
	if want != "" {
		return want
	}
	if fallback != "" {
		return fallback
	}
	return "/tmp"
}
