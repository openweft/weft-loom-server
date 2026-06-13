package workspace

// local.go — the dev-mode workspace provisioner. Two flavours :
//
//   Disabled : neither WEFT_AGENT_URL nor WEFT_NATS_URL set ; Ensure
//              returns a sentinel VM with Health()="dev-local-pty",
//              and api_shell.go reads that as a signal to spawn
//              /bin/bash on the host (legacy V0.3 path). Lets a
//              developer hack on the SPA without booting QEMU.
//
//   QEMU     : WEFT_NATS_URL set ; Ensure boots a microVM via the
//              standard weft-microvm-kernel + workspace OCI image
//              on this host through the existing weft-microvm CLI.
//              First-boot is ~10 s, subsequent SPA reloads reuse
//              the warm VM. Persistence : the VM's CubeFS share
//              backs `/workspace` so the user's files survive the
//              VM's own lifecycle.
//
// The QEMU path is V0.4 wiring — this file gives the contract +
// Disabled fallback so loom-server compiles + dev-mode shells
// keep working today.

import (
	"context"
	"fmt"
	"os"

	"github.com/nats-io/nats.go"
)

// LocalProvisioner is the unified entry point for the two dev-mode
// modes. Picks QEMU when the env vars are wired, falls through to
// the host-pty mode otherwise.
type LocalProvisioner struct {
	NATSURL string // empty = disabled (host pty fallback)
	// QEMUBinary + KernelImage + WorkspaceImage are the inputs the
	// real QEMU boot will need ; left as fields here so the Ensure
	// impl can wire them via env vars without exposing them through
	// the loom-server's main flag surface.
	QEMUBinary     string
	KernelImage    string
	WorkspaceImage string
	// DevAgent boots an in-process mock of weft-microvm-agent when
	// non-nil. The loom-server boot path injects this when running
	// against the embedded broker so a SPA shell click lands on a
	// working host pty via the same NATS round-trip a real
	// production cluster would use.
	DevAgent DevAgentSpawner
}

// NewLocalFromEnv reads the standard weft env vars and returns a
// LocalProvisioner ready for use. Same env-var conventions as the
// other weft control plane components — WEFT_NATS_URL is the broker
// the in-VM agent subscribes to, WEFT_QEMU is the binary path.
//
// In dev mode (WEFT_NATS_URL unset, WEFT_LOOM_DISABLE_EMBEDDED_NATS
// unset), the constructor leaves NATSURL empty ; the loom-server
// boot path replaces it with the embedded broker's URL by calling
// SetNATSURL before Ensure runs. This keeps the env-var contract
// stable while the embedded path stays opt-in via the disable knob.
func NewLocalFromEnv() *LocalProvisioner {
	return &LocalProvisioner{
		NATSURL:        os.Getenv("WEFT_NATS_URL"),
		QEMUBinary:     getenvDefault("WEFT_QEMU", "qemu-system-aarch64"),
		KernelImage:    os.Getenv("WEFT_WORKSPACE_KERNEL_IMAGE"),
		WorkspaceImage: getenvDefault("WEFT_WORKSPACE_IMAGE", "ghcr.io/openweft/weft-loom-workspace:latest"),
	}
}

// SetNATSURL late-binds the broker URL after the embedded broker has
// started ; called by the loom-server boot path so Ensure picks up
// the embedded URL automatically.
func (p *LocalProvisioner) SetNATSURL(url string) {
	p.NATSURL = url
}

// EmbeddedNATSDisabled reports whether the operator opted out of
// auto-starting the embedded broker (e.g. they already run one).
func EmbeddedNATSDisabled() bool {
	return os.Getenv("WEFT_LOOM_DISABLE_EMBEDDED_NATS") == "1"
}

// Ensure returns a workspace VM. When NATS is unset the result is
// a sentinel signalling "fall back to host pty" — see api_shell.go.
func (p *LocalProvisioner) Ensure(ctx context.Context, ident Identity) (*VM, error) {
	if p.NATSURL == "" {
		// Dev mode no isolation : the loom-server's api_shell.go
		// recognises Health()=="dev-local-pty" and spawns /bin/bash
		// directly. The shell-tab still works ; users see a banner.
		ready := make(chan struct{})
		close(ready)
		return &VM{
			VMID:    "dev-local-pty",
			NATSURL: "",
			Ready:   ready,
			Health:  func() string { return "dev-local-pty" },
		}, nil
	}

	// NATS is wired ; dial the broker so the shell + compile
	// handlers can publish on weft.exec.<vmID>.<sid>.* without
	// each handler dialling independently.
	nc, err := nats.Connect(p.NATSURL,
		nats.Name("weft-loom-server workspace="+VMIDForIdentity(ident)),
		nats.MaxReconnects(-1),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect %s: %w", p.NATSURL, err)
	}

	// V0.4 wiring : boot a real QEMU microVM here. Contract :
	//   1. derive vmID = VMIDForIdentity(ident)
	//   2. ensure ~/Library/Application Support/weft-loom/workspaces/<vmID>/
	//      with a persistent VMDK + a workspace-spec.hcl
	//   3. exec qemu-system with the standard weft-microvm-kernel +
	//      workspace.img cmdline (mirrors what `weft microvm boot`
	//      does for a non-workspace VM)
	//   4. wait for the in-VM agent's heartbeat on
	//      weft.heartbeat.<vmID> before closing Ready
	//   5. on shutdown : graceful SIGTERM → QEMU monitor `system_powerdown`
	//
	// Until step 1-5 ship, we still return a healthy VM with the
	// real NATS conn — the shell handler will route through NATS
	// but no agent is listening yet, so frames disappear. Useful
	// for wiring + loom-doctor visibility of the publish path.
	ready := make(chan struct{})
	close(ready)
	vmID := VMIDForIdentity(ident)
	// Per-user host dir used by the in-process devagent (and by the
	// real workspace VM as the CubeFS mount, once that's wired).
	// Created here so an Ensure that runs before the first shell
	// click can return a usable WorkDir.
	workDir := workspaceHostDir(vmID)
	_ = os.MkdirAll(workDir, 0o755)
	vm := &VM{
		VMID:    vmID,
		NATSURL: p.NATSURL,
		Conn:    NewNATSConn(nc),
		WorkDir: workDir,
		Ready:   ready,
		Health:  func() string { return "dev-agent" },
	}
	if p.DevAgent != nil {
		// Boot the in-process devagent so the shell relay round-trip
		// actually lands on a working pty without QEMU.
		if err := p.DevAgent.Spawn(nc, vmID, workDir); err != nil {
			return nil, fmt.Errorf("devagent spawn: %w", err)
		}
	}
	return vm, nil
}

// DevAgentSpawner is the callback the loom-server boot path injects
// to start an in-process mock of weft-microvm-agent. Lives in
// internal/devagent ; we keep it abstracted here so workspace
// stays import-free of devagent (which pulls in os/exec + pty).
type DevAgentSpawner interface {
	Spawn(nc *nats.Conn, vmID, workDir string) error
}

func workspaceHostDir(vmID string) string {
	if base := os.Getenv("WEFT_LOOM_WORKSPACE_DIR"); base != "" {
		return base + "/" + vmID
	}
	if home := os.Getenv("HOME"); home != "" {
		return home + "/.weft-loom/workspaces/" + vmID
	}
	return "/tmp/weft-loom-workspaces/" + vmID
}

func getenvDefault(key, def string) string {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	return v
}
