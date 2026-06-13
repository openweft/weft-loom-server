// Package shares publishes pod.ShareMount messages on `weft.mounts.<vmID>`
// so the workspace μVM's mounts.Subscriber applies them via cubefs.Registry
// (cfs-client) inside the guest.
//
// Two-mode contract :
//
//   - **Dev** (single-binary loom-server on macOS, embedded NATS broker) :
//     the workspace VM mounts /workspace + /opt/tools via virtio-9p in
//     init script. The publisher emits the SAME pod.ShareMount envelope
//     but Backend="virtio9p" carrying just the mount tag — for
//     audit/observability only ; agent guest doesn't act on it (init
//     already mounted). The wire is identical so the prod path is
//     a pure backend swap.
//
//   - **Prod** (loom-server in microVM on weft cluster) : Backend="cubefs"
//     with CubeFS volume + masters. The guest agent's mounts.Subscriber
//     calls cubefs.Registry.Apply → cfs-client mounts the volume R/O at
//     /opt/tools or R/W at /workspace. 0 virtio-9p.
//
// /opt/tools and /workspace use the SAME contract — multi-attach R/O for
// tools (CubeFS handles concurrency natively), multi-attach R/W for
// /workspace (the SPA editor + shell both write). weft-block volumes
// (single-attach NBD) are explicitly NOT used here ; they belong to
// stateful single-writer workloads (DB volumes, OS disks).

package shares

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/nats-io/nats.go"
	"github.com/openweft/weft-microvm-init/pkg/pod"
)

// Backend strings the publisher emits. Empty defaults to CubeFS on the
// agent side ; "virtio9p" is the dev tag (no-op apply).
const (
	BackendVirtio9p = "virtio9p"
	BackendCubeFS   = "cubefs"
)

// Publisher emits pod.ShareMount on `weft.mounts.<vmID>` last-per-subject
// streams. Re-publishing the same ID for the same VM is idempotent
// (mounts.Subscriber dedups by ID). One Publisher per loom-server,
// shared across all workspace VMs.
type Publisher struct {
	Conn  *nats.Conn
	mu    sync.Mutex
	// outstanding maps vmID → set of mount IDs we've published, so
	// teardown can unmount them all when the VM is stopped.
	outstanding map[string]map[string]struct{}
}

// New wraps nc. nc == nil disables publishing (no-op), useful in tests.
func New(nc *nats.Conn) *Publisher {
	return &Publisher{Conn: nc, outstanding: map[string]map[string]struct{}{}}
}

// MountAny is the type-erased entry point for callers that don't
// want to import pod just to publish a share. Accepts a pod.ShareMount
// value (boxed in interface{}) and forwards to Mount. Anything else
// returns an error.
func (p *Publisher) MountAny(vmID string, m any) error {
	if mount, ok := m.(pod.ShareMount); ok {
		return p.Mount(vmID, mount)
	}
	return fmt.Errorf("publisher: MountAny expected pod.ShareMount, got %T", m)
}

// Mount publishes a mount intent for vmID. Idempotent on (vmID, m.ID) :
// a second call replaces the prior payload (the subject's last-per-
// subject retention means new subscribers see the latest only). Caller
// is responsible for setting m.Backend ; empty defaults CubeFS on the
// guest side per pod.ShareMount semantics.
func (p *Publisher) Mount(vmID string, m pod.ShareMount) error {
	if p == nil || p.Conn == nil {
		return nil
	}
	if vmID == "" {
		return fmt.Errorf("publisher: vmID required")
	}
	if err := m.Validate(); err != nil {
		return fmt.Errorf("publisher: invalid mount: %w", err)
	}
	body, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("publisher: marshal: %w", err)
	}
	subject := "weft.mounts." + vmID
	if err := p.Conn.Publish(subject, body); err != nil {
		return fmt.Errorf("publisher: publish %s: %w", subject, err)
	}
	p.track(vmID, m.ID)
	return nil
}

// Unmount publishes an unmount intent for (vmID, mountID). Tolerates a
// VM we never published to — best-effort cleanup.
func (p *Publisher) Unmount(vmID, mountID, mountPoint string) error {
	if p == nil || p.Conn == nil {
		return nil
	}
	if vmID == "" || mountID == "" {
		return fmt.Errorf("publisher: vmID + mountID required for unmount")
	}
	m := pod.ShareMount{
		ID:         mountID,
		Action:     pod.MountActionUnmount,
		MountPoint: mountPoint,
	}
	body, err := json.Marshal(m)
	if err != nil {
		return err
	}
	subject := "weft.mounts." + vmID
	if err := p.Conn.Publish(subject, body); err != nil {
		return fmt.Errorf("publisher: publish unmount %s: %w", subject, err)
	}
	p.untrack(vmID, mountID)
	return nil
}

// TeardownVM unmounts every mount the publisher previously announced
// for vmID. Called when the workspace VM is being stopped so the agent
// (or its successor on respawn) doesn't try to remount stale shares.
func (p *Publisher) TeardownVM(vmID string) error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	ids := p.outstanding[vmID]
	delete(p.outstanding, vmID)
	p.mu.Unlock()
	for id := range ids {
		_ = p.Unmount(vmID, id, "")
	}
	return nil
}

func (p *Publisher) track(vmID, mountID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	set := p.outstanding[vmID]
	if set == nil {
		set = map[string]struct{}{}
		p.outstanding[vmID] = set
	}
	set[mountID] = struct{}{}
}

func (p *Publisher) untrack(vmID, mountID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if set, ok := p.outstanding[vmID]; ok {
		delete(set, mountID)
		if len(set) == 0 {
			delete(p.outstanding, vmID)
		}
	}
}
