// Package workspace owns the per-user microVM that the loom-server
// shells + compile jobs run in. One VM per identity, persistent
// VMDK, brought up on first login + kept warm for the rest of the
// session.
//
// Two backends share the same Provisioner interface :
//
//   - Local : the dev-mode QEMU/TCG path. Boots an actual microVM
//             via the standard weft-microvm-kernel + workspace
//             image on the loom-server host (Mac with Apple-VZ-
//             disabled QEMU is the canonical dev box). Slow cold
//             boot (~10s) but the VM is reused across SPA reloads
//             so the cost is paid once.
//
//   - Agent : the prod path. Talks to a weft-agent on a hypervisor
//             host and asks for a workspace VM to be placed there.
//             The shell + compile traffic still flows through NATS
//             (weft.exec.<vmID>.<sid>.{in,out}) — the loom-server
//             is a thin router in both cases.
//
// In dev mode (no WEFT_AGENT_URL + no WEFT_NATS_URL) the workspace
// falls back to the legacy local-pty path in api_shell.go : the
// user gets a host bash, a "dev mode no isolation" banner shows up
// in the SPA, compile uses the on-host pdflatex / go / pandoc.
package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
)

// Identity is the auth-identity slice the workspace cares about.
// We keep a small purpose-fitted view rather than depending on the
// full auth.Identity so the package stays test-friendly.
type Identity struct {
	Subject string
	Email   string
}

// VM bundles everything the shell + compile routers need to wire a
// session to the user's workspace. VMID is what gets baked into the
// NATS subjects ; NATSURL is the broker the agent inside the VM is
// subscribed on ; Conn is the live nats.Conn the loom-server uses
// to publish + subscribe in the user's behalf (nil when the
// provisioner is in host-pty mode).
type VM struct {
	VMID    string
	NATSURL string
	Conn    NATSPubSub
	// WorkDir is where the in-VM agent's shell pty boots into. In
	// dev mode the in-process devagent uses this to pick the host
	// directory ; the real agent inside the workspace VM uses its
	// own /workspace mount and ignores this hint.
	WorkDir string
	// Ready signals when the VM has finished its first-boot
	// reconcile (CubeFS mount, weft-microvm-agent's subscribers
	// warm). Closed by the provisioner ; never reopened.
	Ready <-chan struct{}
	// Dead signals that the VM exited — QEMU killed, panicked,
	// host reboot. The Registry watches this to invalidate its
	// cache on the next Ensure so the user gets a fresh boot
	// rather than a stale handle. Provisioners that don't track
	// VM death (e.g. the no-op dev-local-pty sentinel) may leave
	// this nil.
	Dead <-chan struct{}
	// Health is "healthy" once the agent's heartbeat is recent. The
	// router uses this to decide whether to publish into the in
	// subject or surface a 503 to the SPA.
	Health func() string
}

// NATSPubSub is the slice of nats.Conn the workspace uses : Publish
// + Subscribe. Kept abstract so the shell handler is testable with
// an in-memory stub without standing up a broker.
type NATSPubSub interface {
	Publish(subject string, data []byte) error
	Subscribe(subject string, cb func(subj string, data []byte)) (Unsubscriber, error)
}

// Unsubscriber lets the shell handler tear down its in-subject
// subscription when the SPA WS hangs up.
type Unsubscriber interface {
	Unsubscribe() error
}

// Provisioner is the abstract VM lifecycle owner. Each impl handles
// boot + image refresh + teardown idempotently.
type Provisioner interface {
	Ensure(ctx context.Context, ident Identity) (*VM, error)
}

// VMIDForIdentity is a stable hash of the user's subject so two
// runs of the loom-server land on the same VM directory (and the
// same NATS subjects, so JetStream replay of containers + mounts
// finds the previously-desired state). Lowercased hex prefix —
// short enough to read in a log line, deterministic enough to
// blame a user's VM in incident review.
func VMIDForIdentity(id Identity) string {
	if id.Subject == "" {
		return "anon"
	}
	h := sha256.Sum256([]byte("weft-loom/workspace/" + id.Subject))
	return "wl-" + hex.EncodeToString(h[:6])
}

// Registry caches Ensure results so concurrent SPA reloads don't
// each kick off a fresh boot. Per-identity result + a "dead" flag :
// when a provisioner-spawned VM exits (QEMU killed, process panic,
// host reboot), the next Ensure invalidates the cache + re-runs the
// provisioner. The provisioner signals death by closing the VM's
// Dead channel (added in V0.5.1).
type Registry struct {
	mu sync.Mutex
	p  Provisioner
	vm map[string]*ensureResult
}

type ensureResult struct {
	once  sync.Once
	vm    *VM
	err   error
	dead  bool // set true when the VM exited ; next Ensure re-spawns
}

// NewRegistry wraps p in a per-identity memoiser.
func NewRegistry(p Provisioner) *Registry {
	return &Registry{p: p, vm: map[string]*ensureResult{}}
}

// Ensure returns the user's workspace VM, booting it on first call.
// Subsequent calls return the cached result, unless the previous VM
// exited — in which case the cache is invalidated + a fresh boot
// triggered. The provisioner is responsible for signalling death
// via VM.Dead (closed by the boot goroutine when QEMU exits).
func (r *Registry) Ensure(ctx context.Context, ident Identity) (*VM, error) {
	key := VMIDForIdentity(ident)
	r.mu.Lock()
	er, ok := r.vm[key]
	if ok {
		// Cache hit ; check whether the previous run died. The
		// Dead channel is closed by the provisioner when the VM
		// exits — see qemu.go's boot goroutine.
		if er.vm != nil && er.vm.Dead != nil {
			select {
			case <-er.vm.Dead:
				// stale ; invalidate + fall through to fresh boot
				delete(r.vm, key)
				ok = false
			default:
			}
		}
	}
	if !ok {
		er = &ensureResult{}
		r.vm[key] = er
	}
	r.mu.Unlock()
	er.once.Do(func() {
		er.vm, er.err = r.p.Ensure(ctx, ident)
	})
	if er.err != nil {
		return nil, fmt.Errorf("workspace.Ensure %s: %w", key, er.err)
	}
	return er.vm, nil
}
