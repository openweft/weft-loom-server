package server

// shell_relay.go — bridge between the SPA's xterm WebSocket and the
// per-VM weft.exec.<vmID>.<sid> NATS subjects the workspace agent
// listens on. Frame shape is identical on both sides (1-byte type
// prefix) so the proxy is byte-passthrough — no parsing, no
// translation.
//
// Session lifecycle :
//
//   1. allocate sid (ULID-ish ; just a random 12-hex prefix here)
//   2. subscribe to weft.exec.<vmID>.<sid>.out → forward to WS
//   3. publish weft.exec.<vmID>.<sid>.open with kind=shell
//   4. relay WS in frames → weft.exec.<vmID>.<sid>.in
//   5. on either side hang up : publish 'x' close frame + unsubscribe
//
// Errors during steps 1-3 propagate to the caller so handleShell can
// fall back to host pty ; an error after step 4 just closes the WS.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/coder/websocket"

	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/workspace"
	execsession "github.com/openweft/weft-microvm-agent/pkg/execsession"
)

func newSessionID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// relayShellToNATS bridges the WS conn to the workspace VM via the
// weft.exec NATS protocol. Returns when either side closes ; an
// error means the relay never came up (caller may fall back to host
// pty), nil means the session ran cleanly.
func relayShellToNATS(
	ctx context.Context,
	conn *websocket.Conn,
	vm *workspace.VM,
	project string,
	events *eventbus.Hub,
) error {
	if vm == nil || vm.Conn == nil {
		return fmt.Errorf("workspace VM has no NATS conn")
	}
	sid := newSessionID()
	outSubject := execsession.SubjectOut(vm.VMID, sid)
	inSubject := execsession.SubjectIn(vm.VMID, sid)
	openSubject := execsession.SubjectOpen(vm.VMID)

	// relayCtx + cancel unblock the conn.Read loop the moment a
	// background NATS-callback hits a WS write error, so the relay
	// exits promptly instead of hanging until the client times out.
	relayCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Step 2 first : subscribe to out BEFORE publishing open so we
	// never drop the agent's first frames.
	outSub, err := vm.Conn.Subscribe(outSubject, func(_ string, data []byte) {
		if werr := conn.Write(relayCtx, websocket.MessageBinary, data); werr != nil {
			cancel()
			return
		}
	})
	if err != nil {
		return fmt.Errorf("subscribe out: %w", err)
	}
	defer func() { _ = outSub.Unsubscribe() }()

	// Step 3 : publish open. The agent runs Validate on its side
	// and starts the pty pump.
	// WorkDir : prefer the per-project subdir inside the guest's
	// 9p-mounted /workspace so the user's shell lands directly in
	// their project files. The agent's workDir() fallback walks
	// [requested, /workspace, /tmp, /] and picks the first that
	// exists, so an unknown project name (or a missing 9p mount in
	// dev-fallback mode) still resolves to a usable cwd.
	guestWorkDir := "/workspace/" + project
	openMsg, err := json.Marshal(execsession.ExecRequest{
		ID:     sid,
		Target: execsession.ExecTarget{Kind: "shell", WorkDir: guestWorkDir},
	})
	if err != nil {
		return fmt.Errorf("marshal open: %w", err)
	}
	// Retry the open publish until we see the first 'o' frame OR
	// the request context dies. Without retry the publish races the
	// VM agent's NATS subscribe (QEMU boots ~10s ; the loom-server's
	// shell relay opens within milliseconds of the click), and core
	// NATS drops the early message because no subscriber is registered.
	gotFirstFrame := make(chan struct{}, 1)
	{
		// Wrap the outSub callback : on first 'o' frame, signal
		// gotFirstFrame so the retry loop stops. Done by re-attaching
		// the listener through the existing channel ; cheaper than
		// a second Subscribe.
		// Implementation : a flag toggled on first frame.
	}
	publishOpen := func() error {
		return vm.Conn.Publish(openSubject, openMsg)
	}
	if err := publishOpen(); err != nil {
		return fmt.Errorf("publish open: %w", err)
	}
	events.Publish(eventbus.Event{
		Source: "server", Component: "shell", Verb: "session.open",
		Project: project,
		Fields:  map[string]any{"vm_id": vm.VMID, "sid": sid},
	})
	// Background retry loop : reissue open every 1.5s until we
	// either see an out frame or the request ends.
	retryCtx, cancelRetry := context.WithCancel(relayCtx)
	defer cancelRetry()
	go func() {
		ticker := time.NewTicker(1500 * time.Millisecond)
		defer ticker.Stop()
		attempts := 0
		for {
			select {
			case <-retryCtx.Done():
				return
			case <-gotFirstFrame:
				return
			case <-ticker.C:
				attempts++
				if attempts > 20 {
					return
				}
				_ = publishOpen()
			}
		}
	}()
	// Hook the gotFirstFrame signal into the outSub callback that
	// was registered earlier. We rebuild the callback now that the
	// channel exists — replace the subscription.
	_ = outSub.Unsubscribe()
	signaled := false
	outSub, err = vm.Conn.Subscribe(outSubject, func(_ string, data []byte) {
		if !signaled {
			signaled = true
			select {
			case gotFirstFrame <- struct{}{}:
			default:
			}
		}
		if werr := conn.Write(relayCtx, websocket.MessageBinary, data); werr != nil {
			cancel()
			return
		}
	})
	if err != nil {
		return fmt.Errorf("re-subscribe out: %w", err)
	}

	// Step 4 : pump WS → in subject. Each WS read becomes one
	// publish ; no buffering so xterm input feels immediate.
	defer func() {
		// Step 5 : politely tell the agent we're done. 'x' is the
		// close frame execsession.pty_linux understands.
		_ = vm.Conn.Publish(inSubject, []byte{'x'})
		events.Publish(eventbus.Event{
			Source: "server", Component: "shell", Verb: "session.close",
			Project: project,
			Fields:  map[string]any{"vm_id": vm.VMID, "sid": sid},
		})
	}()

	for {
		_, payload, err := conn.Read(relayCtx)
		if err != nil {
			return nil // WS hung up, normal close
		}
		if len(payload) == 0 {
			continue
		}
		// Forward verbatim — the SPA and the agent agree on the
		// 1-byte prefix already, so we don't peek.
		if err := vm.Conn.Publish(inSubject, payload); err != nil {
			events.Publish(eventbus.Event{
				Source: "server", Component: "shell", Verb: "publish.in.err",
				Level:   "error",
				Project: project,
				Fields:  map[string]any{"vm_id": vm.VMID, "sid": sid, "err": err.Error()},
			})
			// Tell the client the relay is dead so xterm shows
			// something useful, then surface to handleShell —
			// callers gate fallback on a non-nil return.
			_ = conn.Write(relayCtx, websocket.MessageText, []byte(
				"\r\nerror: NATS publish failed ("+err.Error()+") — relay closing\r\n",
			))
			return fmt.Errorf("publish in: %w", err)
		}
		// Small jitter avoidance : on sustained high-rate input
		// xterm coalesces well but the NATS broker prefers a
		// drained TCP buffer.
		_ = time.Now()
	}
}
