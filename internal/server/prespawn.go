package server

// prespawn.go — kick off workspace VM boots at loom-server startup so
// the first SPA shell click lands on an already-warm VM. Cuts the
// user-visible boot delay from ~5 s (cold QEMU boot) to ~0 ms.
//
// In dev mode we pre-spawn the synthetic "dev-user" identity. In
// prod the operator sets WEFT_LOOM_PRESPAWN_SUBJECTS to a CSV of
// subjects ; each kicks off in parallel with its own VM. Idempotent
// against the workspace.Registry — re-pre-spawning a live identity
// is a no-op.

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/shares"
	"github.com/openweft/weft-loom-server/internal/workspace"
)

func (s *Server) prespawnWorkspaces() {
	if s.workspaces == nil {
		return
	}
	subjects := prespawnSubjects()
	for _, sub := range subjects {
		go s.prespawnOne(sub)
	}
}

// prespawnSubjects reads WEFT_LOOM_PRESPAWN_SUBJECTS (CSV) ; falls
// back to ["dev-user"] in dev mode (no auth configured).
func prespawnSubjects() []string {
	csv := os.Getenv("WEFT_LOOM_PRESPAWN_SUBJECTS")
	if csv == "" {
		return []string{"dev-user"}
	}
	var out []string
	for _, p := range strings.Split(csv, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// prespawnOne kicks off the VM for one identity ; logs timing to the
// loom-doctor event stream so an operator can see when the warm
// pool is ready.
func (s *Server) prespawnOne(subject string) {
	start := time.Now()
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "workspace", Verb: "prespawn.start",
		Fields: map[string]any{"subject": subject},
	})
	// Ensure runs the QEMU boot in a goroutine ; we await the VM's
	// Ready channel so the event timing reflects "agent subscribed",
	// not "qemu exec returned".
	vm, err := s.workspaces.Ensure(context.Background(), workspace.Identity{Subject: subject})
	if err != nil {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "workspace", Verb: "prespawn.err",
			Level:  "warn",
			Fields: map[string]any{"subject": subject, "err": err.Error()},
		})
		return
	}
	// We DON'T wait on vm.Ready : the QEMUProvisioner currently
	// closes Ready only on VM exit (not on first boot), so blocking
	// here would defer announceShares indefinitely. For dev the
	// init script already mounts /workspace + /opt/tools via 9p
	// before the agent attaches ; announceShares emits the audit
	// envelope synchronously. Prod will switch to a NATS-heartbeat-
	// based ready signal once the boot()-side wire lands.
	_ = vm.Ready
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "workspace", Verb: "prespawn.ready",
		Fields: map[string]any{
			"subject":  subject,
			"vm_id":    vm.VMID,
			"elapsed_ms": time.Since(start).Milliseconds(),
		},
	})
	// Announce the two canonical shares on weft.mounts.<vmID>.
	// In dev backend=virtio9p (the init script already mounted them via
	// the 9p host bridge) ; in prod backend=cubefs and the guest's
	// mounts.Subscriber calls cfs-client. Same wire either way.
	s.announceShares(vm.VMID)
}

// announceShares publishes the /workspace + /opt/tools pod.ShareMount
// envelopes for the given VM. Best-effort : a publish failure logs
// but doesn't block — the init script's 9p mounts have already
// satisfied the dev path, so the announcement is observability only.
func (s *Server) announceShares(vmID string) {
	if s.shares == nil {
		return
	}
	cubefs := sharesCubeFSFromEnv()
	wsCfg := shares.WorkspaceConfig{HostPath: os.Getenv("WEFT_LOOM_STORAGE_ROOT"), CubeFS: cubefs}
	toolsCfg := shares.ToolsConfig{HostPath: os.Getenv("WEFT_LOOM_TOOLS_PATH"), CubeFS: cubefs}
	wsMount, wsOK := shares.WorkspaceMount(vmID, wsCfg)
	toolsMount, toolsOK := shares.ToolsMount(vmID, toolsCfg)
	for _, ent := range []struct {
		name  string
		ok    bool
		mount any
	}{
		{"workspace", wsOK, wsMount},
		{"tools", toolsOK, toolsMount},
	} {
		if !ent.ok {
			// Dev path (no CubeFS configured) : the init script
			// mounted /workspace + /opt/tools via virtio-9p ; no
			// announce wire today, prod CubeFS lands later.
			continue
		}
		if err := s.shares.MountAny(vmID, ent.mount); err != nil {
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "shares", Verb: "announce.err",
				Level:  "warn",
				Fields: map[string]any{"vm_id": vmID, "mount": ent.name, "err": err.Error()},
			})
			continue
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "shares", Verb: "announce.ok",
			Fields: map[string]any{"vm_id": vmID, "mount": ent.name},
		})
	}
}

// sharesCubeFSFromEnv reads the prod CubeFS connection from the
// operator env (WEFT_CUBEFS_VOLUME, WEFT_CUBEFS_MASTERS,
// WEFT_CUBEFS_OWNER, WEFT_CUBEFS_ACCESS_KEY, WEFT_CUBEFS_SECRET_KEY).
// Returns nil in dev (volume unset) → announceShares skips publish.
func sharesCubeFSFromEnv() *shares.CubeFSConfig {
	vol := os.Getenv("WEFT_CUBEFS_VOLUME")
	if vol == "" {
		return nil
	}
	mastersCSV := os.Getenv("WEFT_CUBEFS_MASTERS")
	var masters []string
	for _, m := range strings.Split(mastersCSV, ",") {
		m = strings.TrimSpace(m)
		if m != "" {
			masters = append(masters, m)
		}
	}
	return &shares.CubeFSConfig{
		Volume:    vol,
		Masters:   masters,
		Owner:     os.Getenv("WEFT_CUBEFS_OWNER"),
		AccessKey: os.Getenv("WEFT_CUBEFS_ACCESS_KEY"),
		SecretKey: os.Getenv("WEFT_CUBEFS_SECRET_KEY"),
	}
}
