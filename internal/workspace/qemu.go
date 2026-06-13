package workspace

// qemu.go — real QEMU/TCG boot of a per-user workspace microVM on
// the loom-server host. Replaces the devagent-in-process path when
// the operator sets WEFT_LOOM_WORKSPACE_BACKEND=qemu (default in
// production ; dev keeps "devagent" for fast iteration).
//
// Lifecycle per identity :
//
//   1. ensure ~/.weft-loom/workspaces/<vmID>/ exists + has a
//      persistent qcow2 (~5 GB sparse) for /workspace
//   2. ensure the kernel image is pulled from the configured OCI
//      ref (weft-microvm-kernel artifact ; mediatype
//      application/vnd.openweft.microvm.kernel.image) — same
//      mechanism `weft microvm pull-kernel` uses
//   3. ensure the workspace rootfs (cpio.gz) is pulled from the
//      WorkspaceImage OCI ref (weft-loom-workspace)
//   4. exec qemu-system-aarch64 with :
//        -kernel <pulled kernel>
//        -initrd <pulled workspace cpio.gz>
//        -append "weft.vmid=<id> weft.nats=<host:port> console=ttyAMA0"
//        -netdev user,id=net0,hostfwd=tcp:127.0.0.1:0-:22
//        -virtfs local,path=<host workspace dir>,mount_tag=workspace,security_model=passthrough
//        -nographic -accel tcg
//   5. wait for the in-VM agent's first heartbeat on
//      weft.heartbeat.<vmID> before closing Ready
//   6. on loom-server shutdown : qemu-monitor `system_powerdown`
//      with 10s graceful timeout, then SIGKILL
//
// The QEMUProvisioner only runs the wire-up ; the actual qemu
// binary lookup + kernel/rootfs pull funnel through the same env
// vars the LocalProvisioner already reads
// (WEFT_QEMU/WEFT_WORKSPACE_KERNEL_IMAGE/WEFT_WORKSPACE_IMAGE) so
// the operator surface stays small.

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/nats-io/nats.go"
)

// QEMUBackendSelected reports whether the operator picked the QEMU
// workspace backend via WEFT_LOOM_WORKSPACE_BACKEND=qemu. Devagent
// (in-process) is the default for unset/anything else.
func QEMUBackendSelected() bool {
	return strings.ToLower(os.Getenv("WEFT_LOOM_WORKSPACE_BACKEND")) == "qemu"
}

// NewQEMUFromEnv builds a QEMUProvisioner from the env-var surface :
// WEFT_NATS_URL, WEFT_QEMU, WEFT_WORKSPACE_KERNEL_IMAGE,
// WEFT_WORKSPACE_IMAGE, WEFT_LOOM_STORAGE_ROOT,
// WEFT_LOOM_TOOLS_PATH. Mirrors NewLocalFromEnv so the operator
// only learns one set of variable names.
func NewQEMUFromEnv(logger *slog.Logger) *QEMUProvisioner {
	return &QEMUProvisioner{
		NATSURL:        os.Getenv("WEFT_NATS_URL"),
		QEMUBinary:     getenvDefault("WEFT_QEMU", "qemu-system-aarch64"),
		KernelImage:    os.Getenv("WEFT_WORKSPACE_KERNEL_IMAGE"),
		WorkspaceImage: getenvDefault("WEFT_WORKSPACE_IMAGE", "ghcr.io/openweft/weft-loom-workspace:latest"),
		ImagePuller:    NewImagePuller(os.Getenv("WEFT_LOOM_IMAGE_CACHE")),
		ProjectsRoot:   getenvDefault("WEFT_LOOM_STORAGE_ROOT", "/tmp/weft-loom-data"),
		ToolsPath:      os.Getenv("WEFT_LOOM_TOOLS_PATH"),
		Logger:         logger,
	}
}

// sanitiseSubject mirrors what the project store does to a user's
// identity subject before using it as a directory name : strips
// path separators + collapses whitespace, lowercase. Kept local
// here to avoid pulling internal/project as a dep.
func sanitiseSubject(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '/' || c == '\\' || c == '.' || c == ' ' {
			out = append(out, '-')
			continue
		}
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return "anon"
	}
	return string(out)
}

// QEMUProvisioner boots one workspace microVM per Identity.
//
// NATSURL is the URL the loom-server itself uses (typically
// 127.0.0.1:4222 for the embedded broker, or the cluster broker
// LB in prod). GuestNATSURL is the URL the VM's agent dials —
// usually the same in prod (a NATS LB reachable from both),
// but with the embedded broker in dev it's a different shape :
// QEMU's user-mode SLIRP maps `10.0.2.2` to the host's
// `127.0.0.1`, so the guest needs `nats://10.0.2.2:4222` even
// when the loom-server itself uses `nats://127.0.0.1:4222`.
type QEMUProvisioner struct {
	NATSURL        string
	GuestNATSURL   string
	QEMUBinary     string
	KernelImage    string
	WorkspaceImage string
	// ImagePuller resolves WEFT_WORKSPACE_BASE_QCOW2 — when it
	// looks like an OCI ref, the puller fetches the artifact
	// + caches it ; when it's a local path, returned as-is.
	// nil = local-only mode (used in tests).
	ImagePuller *ImagePuller
	// ProjectsRoot is the loom-server's storage root path on the
	// host. The boot mounts <ProjectsRoot>/<subject>/ at /workspace
	// inside the guest via virtio-9p so the shell sees the user's
	// actual project files. The shell + compile path always run
	// against this mount.
	ProjectsRoot string
	// ToolsPath is the host directory that holds unpacked OCI tool
	// rootfs (texlive / markdown / ...) + their pre-rendered crun
	// bundles. Mounted at /opt/tools/ inside the guest read-only.
	// One copy on the host serves every user VM ; the tool wrappers
	// `crun exec` against the bundle without pulling the 5 GiB
	// texlive image per-VM. Same wire (virtio-9p) as /workspace ;
	// in prod the same dir is backed by a weft-block volume with
	// per-tool R/O snapshots exposed via NBD.
	ToolsPath string
	Logger    *slog.Logger
}

// Ensure boots (or returns a cached handle for) the user's
// workspace microVM. The current impl validates the host has the
// needed tools available + materialises the per-user directory ; the
// QEMU exec itself is the next sub-step (it spans the kernel +
// rootfs pull paths, which we land in a dedicated PR so this file
// stays reviewable).
func (p *QEMUProvisioner) Ensure(ctx context.Context, ident Identity) (*VM, error) {
	if p.NATSURL == "" {
		return nil, fmt.Errorf("qemu: WEFT_NATS_URL required for QEMU workspace backend")
	}
	vmID := VMIDForIdentity(ident)
	dir, err := workspaceDir(vmID)
	if err != nil {
		return nil, fmt.Errorf("workspace dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}

	if _, err := exec.LookPath(p.qemuBin()); err != nil {
		return nil, fmt.Errorf("qemu binary %q not on PATH (install with `pkgx qemu`)", p.qemuBin())
	}

	nc, err := nats.Connect(p.NATSURL, nats.Name("weft-loom-qemu-workspace="+vmID))
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}

	// Heartbeat watcher : we keep the broadcast subscription so the
	// Health() snapshot reflects the agent's last "I'm alive" within
	// the 10 s window the convention uses across openweft.
	state := newHealthState()
	hbSub, err := nc.Subscribe("weft.heartbeat."+vmID, func(_ *nats.Msg) {
		state.beat()
	})
	if err != nil {
		_ = nc.Drain()
		return nil, fmt.Errorf("subscribe heartbeat: %w", err)
	}

	// Boot the VM in a child process. The child takes over qemu's
	// lifecycle ; we surface the PID to loom-doctor + tear down on
	// loom-server shutdown via the registered cancel.
	ready := make(chan struct{})
	guestURL := p.GuestNATSURL
	if guestURL == "" {
		guestURL = p.NATSURL
	}
	// Per-user storage on the host. This is what the loom-server's
	// project store layout puts under <storage_root>/<user>/. We
	// pass it to boot so virtio-9p exposes the user's actual files
	// at /workspace inside the guest.
	userStorage := ""
	if p.ProjectsRoot != "" {
		userStorage = filepath.Join(p.ProjectsRoot, sanitiseSubject(ident.Subject))
		_ = os.MkdirAll(userStorage, 0o755)
	}
	// IMPORTANT : the boot goroutine outlives the HTTP request that
	// triggered Ensure — using ctx (the request ctx) would cancel
	// QEMU the moment the WS upgrade returns. Use Background() ;
	// the loom-server shutdown path tears down via the Registry's
	// Close (TODO) instead.
	//
	// Dead channel closes when boot() returns (clean exit OR error).
	// Registry watches it to invalidate the cache + re-spawn on the
	// next Ensure, so a killed QEMU doesn't strand the user.
	dead := make(chan struct{})
	// Ready closes when the agent inside the VM publishes its
	// `weft.agent.<vmID>.up` heartbeat (the agent flushes this
	// once execsession is subscribed). Decouples Ready from VM
	// exit, so prespawn + share announcement land at the right
	// moment instead of waiting for VM shutdown.
	if nc != nil {
		var subOnce sync.Once
		readyCloser := func() { subOnce.Do(func() { close(ready) }) }
		readySub, err := nc.Subscribe("weft.agent."+vmID+".up", func(*nats.Msg) {
			readyCloser()
		})
		if err == nil {
			// Drop the subscription as soon as ready fires, so the
			// broker doesn't keep a dead handler around per VM.
			go func() {
				<-ready
				_ = readySub.Unsubscribe()
			}()
		} else if p.Logger != nil {
			p.Logger.Warn("qemu ready watch subscribe failed; falling back to dead-only ready",
				"vm_id", vmID, "err", err)
			// Fall back to the old defer-close on dead so we don't
			// leak the channel.
			go func() { <-dead; readyCloser() }()
		}
	} else {
		// No broker → close ready immediately (best-effort).
		close(ready)
	}
	go func() {
		defer close(dead)
		// On VM death tear down the per-VM NATS handles so they don't
		// leak for the loom-server's lifetime when a guest panics or
		// the host kills qemu.
		defer func() {
			_ = hbSub.Unsubscribe()
			_ = nc.Drain()
		}()
		if err := p.boot(context.Background(), dir, vmID, guestURL, userStorage); err != nil {
			if p.Logger != nil {
				p.Logger.Warn("qemu boot failed", "vm_id", vmID, "err", err)
			}
			return
		}
		if p.Logger != nil {
			p.Logger.Info("qemu exited cleanly", "vm_id", vmID)
		}
	}()

	var closeOnce sync.Once
	closer := func() {
		closeOnce.Do(func() {
			_ = hbSub.Unsubscribe()
			_ = nc.Drain()
		})
	}
	return &VM{
		VMID:    vmID,
		NATSURL: p.NATSURL,
		Conn:    NewNATSConn(nc),
		WorkDir: dir,
		Ready:   ready,
		Dead:    dead,
		Health:  state.snapshot,
		Close:   closer,
	}, nil
}

// boot is the qemu exec path. Kept separate so the unit test driving
// Ensure can stub it without spawning a real VM ; the integration
// test that actually fires up QEMU lives under //go:build integration.
// boot launches qemu for the user's workspace VM.
//
// dir         : per-VM state dir on the host (overlay qcow2 + monitor socket)
// vmID        : stable workspace handle
// natsURL     : URL the in-guest agent dials for exec sessions
// userStorage : host path mounted at /workspace inside the guest
//               via virtio-9p (the user's project files). The boot
//               must mount the user's actual files there — tooling
//               comes from OCI containers the agent pulls, never
//               from a host bind.
func (p *QEMUProvisioner) boot(ctx context.Context, dir, vmID, natsURL, userStorage string) error {
	kernel := p.KernelImage
	if kernel == "" {
		return fmt.Errorf("WEFT_WORKSPACE_KERNEL_IMAGE not set ; run `weft microvm pull-kernel` + point this env at the cached file")
	}
	if _, err := os.Stat(kernel); err != nil {
		return fmt.Errorf("kernel image %s: %w", kernel, err)
	}
	// Rootfs : per-user copy preferred, but if missing we fall back
	// to the operator-provided shared template (WEFT_WORKSPACE_ROOTFS).
	// In dev mode the operator typically points at the prebuilt
	// /tmp/weft-loom-workspace-build/workspace-alpine.cpio.gz one ;
	// in prod the loom-server pulls the OCI weft-loom-workspace
	// artifact + unpacks it per-user at first Ensure.
	rootfs := filepath.Join(dir, "workspace.cpio.gz")
	if _, err := os.Stat(rootfs); err != nil {
		// Fall back to operator-provided shared template (saves
		// pulling+unpacking the OCI artifact per-user in dev mode).
		shared := os.Getenv("WEFT_WORKSPACE_ROOTFS")
		if shared == "" {
			return fmt.Errorf("rootfs %s: %w (pull weft-loom-workspace OCI artifact first ; or set WEFT_WORKSPACE_ROOTFS to a prebuilt cpio.gz)", rootfs, err)
		}
		if _, sharedErr := os.Stat(shared); sharedErr != nil {
			return fmt.Errorf("WEFT_WORKSPACE_ROOTFS %s: %w", shared, sharedErr)
		}
		rootfs = shared
	}
	// Per-user workspace qcow2 : CoW clone from the operator-provided
	// base (built once from the OCI weft-loom-workspace image). The
	// overlay is created on first Ensure ; subsequent boots reuse it
	// + see all the user's writes preserved. Same model longhorn /
	// weft-block does internally with chained replica snapshots.
	overlayQcow := filepath.Join(dir, "workspace.qcow2")
	if _, err := os.Stat(overlayQcow); err != nil {
		baseRef := os.Getenv("WEFT_WORKSPACE_BASE_QCOW2")
		if baseRef != "" {
			// Resolve the base reference : when it's an OCI ref
			// (ghcr.io/...) the puller fetches the artifact +
			// caches it under ~/.weft-loom/images/ ; local paths
			// pass through. Same env var, two backends.
			var base string
			var resolveErr error
			if p.ImagePuller != nil {
				base, resolveErr = p.ImagePuller.ResolveBaseQcow2(ctx, baseRef)
			} else {
				base = baseRef
				if _, statErr := os.Stat(baseRef); statErr != nil {
					resolveErr = statErr
				}
			}
			if resolveErr != nil {
				return fmt.Errorf("resolve base qcow2 %s: %w", baseRef, resolveErr)
			}
			if p.Logger != nil {
				p.Logger.Info("workspace base qcow2 resolved", "ref", baseRef, "path", base)
			}
			create := exec.CommandContext(ctx, "qemu-img", "create",
				"-f", "qcow2", "-F", "qcow2", "-b", base, overlayQcow)
			create.Stdout, create.Stderr = os.Stderr, os.Stderr
			if err := create.Run(); err != nil {
				return fmt.Errorf("qemu-img create overlay %s (backing=%s): %w", overlayQcow, base, err)
			}
			if p.Logger != nil {
				p.Logger.Info("workspace.qcow2 created from base (CoW clone)", "overlay", overlayQcow, "base", base)
			}
		} else {
			// No base configured : create a plain 2 GiB qcow2 the
			// init will format with ext4 on first boot.
			create := exec.CommandContext(ctx, "qemu-img", "create",
				"-f", "qcow2", overlayQcow, "2G")
			create.Stdout, create.Stderr = os.Stderr, os.Stderr
			if err := create.Run(); err != nil {
				return fmt.Errorf("qemu-img create blank %s: %w", overlayQcow, err)
			}
		}
	}

	// QEMU monitor over a unix socket lets loom-server's shutdown
	// path send a clean `system_powerdown` (ACPI) instead of SIGKILL.
	// The guest's init traps SIGTERM → sync + reboot ; ~2 s vs ~0 ms
	// kill but no data loss on the qcow2 overlay.
	monitorSock := filepath.Join(dir, "qemu-monitor.sock")
	_ = os.Remove(monitorSock)
	// Accel : prefer Apple Hypervisor (hvf) on arm64 macOS — TCG
	// software emulation is 5–10× slower for compute-bound workloads
	// like pdflatex. HVF requires arch-match (host arm64 + guest
	// arm64) which is our case. Fall back to TCG when WEFT_QEMU_ACCEL
	// is set to "tcg" by the operator (e.g. nested-VM dev where HVF
	// isn't available).
	accel := os.Getenv("WEFT_QEMU_ACCEL")
	if accel == "" {
		accel = "hvf"
	}
	cpu := "max"
	if accel == "hvf" {
		// HVF rejects -cpu max on arm64 (would expose host CPU model) ;
		// the only accepted -cpu value is "host". TCG keeps "max".
		cpu = "host"
	}
	cmd := exec.CommandContext(ctx, p.qemuBin(),
		"-machine", "virt", "-accel", accel,
		"-cpu", cpu, "-m", "4096", "-smp", "2",
		"-kernel", kernel,
		"-initrd", rootfs,
		"-append", "weft.vmid="+vmID+" weft.nats="+natsURL+" console=ttyAMA0 panic=1",
		"-monitor", "unix:"+monitorSock+",server,nowait",
		// Per-user workspace block device — appears as /dev/vda in
		// the guest, init mounts it at /workspace.
		"-drive", "file="+overlayQcow+",if=virtio,format=qcow2,cache=writeback",
		"-netdev", "user,id=net0",
		"-device", "virtio-net-pci,netdev=net0",
		"-nographic",
	)
	// /workspace = host user storage via virtio-9p. Live bidi : SPA
	// edits land in the host dir, shell reads same bytes through the
	// mount. Tooling stays in OCI containers, never bind host PATHs.
	if userStorage != "" {
		cmd.Args = append(cmd.Args,
			"-fsdev", "local,id=ws,path="+userStorage+",security_model=mapped-xattr",
			"-device", "virtio-9p-pci,fsdev=ws,mount_tag=workspace",
		)
	}
	// /opt/tools = read-only share of every unpacked OCI tool image.
	// Pulled once on the host (internal/toolshare) ; mounted across
	// every user VM — 0 duplication, 0 per-VM pull cost. Wrappers
	// in /usr/local/bin invoke `crun exec` against bundles under
	// /opt/tools/.current/<image>/bundle/.
	if p.ToolsPath != "" {
		cmd.Args = append(cmd.Args,
			"-fsdev", "local,id=tools,path="+p.ToolsPath+",security_model=mapped-xattr,readonly=on",
			"-device", "virtio-9p-pci,fsdev=tools,mount_tag=tools",
		)
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func (p *QEMUProvisioner) qemuBin() string {
	if p.QEMUBinary != "" {
		return p.QEMUBinary
	}
	return "qemu-system-aarch64"
}

func workspaceDir(vmID string) (string, error) {
	if base := os.Getenv("WEFT_LOOM_WORKSPACE_DIR"); base != "" {
		return filepath.Join(base, vmID), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".weft-loom", "workspaces", vmID), nil
}
