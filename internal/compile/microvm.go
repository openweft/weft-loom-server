package compile

// microvm.go — production compile path : dispatch a microVM via the
// local `weft microvm` CLI. The CLI talks to a running weft-agent
// (either local UDS or remote gRPC) and spawns an ephemeral VM from
// the configured OCI image with the project working tree mounted.
//
// This file is the seam : when the WEFT_LOOM_BACKEND env var is
// "microvm", every compile job runs through here ; when it's
// "subprocess" (or empty) the host-side pdflatex / marp / pandoc
// path in compile.go runs instead. Both produce a PDF in scratchDir,
// retrievable via /api/projects/{p}/compile/{id}/artifact.
//
// Why CLI subprocess instead of an in-process Go binding ?
//   - Stable contract : the CLI is the same surface the user uses
//     interactively, so configuration travels (weft config, etc.).
//   - Decoupled lifecycle : an OOM in the VM kills the CLI, not the
//     loom-server process.
//   - Hot-upgradeable : updating weft-microvm doesn't require
//     re-linking loom-server.
//
// V0.5 may switch to a direct gRPC client when the binary footprint
// of pulling weft-microvm's Go module becomes worthwhile.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// imageForLanguage picks the OCI image weft-microvm pulls for a
// given language. The images bundle the toolchain pre-installed so
// the VM boots ready to compile.
//
// Image refs match the published `openweft/weft-loom-*` repos
// (cross-referenced against each repo's build.yml on 2026-06-10).
// Per-cluster override via WEFT_LOOM_IMAGE_<LANG> for air-gapped
// installs pointing at a private registry.
func imageForLanguage(language, engine string, marp bool) string {
	_ = marp
	envOverride := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return def
	}
	switch language {
	case "latex":
		if engine == "gotex" {
			// Pure-Go engine : a FROM-scratch single-binary image, the
			// drop-in alternative to the multi-GB TeX Live image.
			return envOverride("WEFT_LOOM_IMAGE_LATEX_GOTEX", "ghcr.io/openweft/weft-loom-gotex:latest")
		}
		return envOverride("WEFT_LOOM_IMAGE_LATEX", "ghcr.io/openweft/weft-loom-texlive:latest")
	case "markdown":
		// One image covers BOTH marp + pandoc — the runtime picks
		// the binary based on the front-matter.
		return envOverride("WEFT_LOOM_IMAGE_MARKDOWN", "ghcr.io/openweft/weft-loom-markdown:latest")
	case "golang", "go":
		return envOverride("WEFT_LOOM_IMAGE_GOLANG", "ghcr.io/openweft/weft-loom-golang:latest")
	case "python":
		return envOverride("WEFT_LOOM_IMAGE_PYTHON", "ghcr.io/openweft/weft-loom-python:latest")
	case "rust":
		return envOverride("WEFT_LOOM_IMAGE_RUST", "ghcr.io/openweft/weft-loom-rust:latest")
	case "node", "javascript", "typescript":
		return envOverride("WEFT_LOOM_IMAGE_NODE", "ghcr.io/openweft/weft-loom-node:latest")
	case "cpp", "c++", "c":
		return envOverride("WEFT_LOOM_IMAGE_CPP", "ghcr.io/openweft/weft-loom-cpp:latest")
	}
	return ""
}

// useMicroVM reports whether the operator picked microVM dispatch.
// Default for development is subprocess ; production sets
// WEFT_LOOM_BACKEND=microvm at the systemd unit level.
func useMicroVM() bool {
	return strings.ToLower(os.Getenv("WEFT_LOOM_BACKEND")) == "microvm"
}

// compileInMicroVM dispatches the compile to a fresh microVM and
// returns the PDF path under scratchDir.
//
// Flow :
//   1. `weft microvm run` boots the language's OCI image (weft-loom-
//      texlive, weft-loom-markdown — published from the openweft/
//      repos) with two virtio-fs bind mounts :
//        -v <workDir>:/workspace          (project working tree)
//        -v <scratchDir>:/workspace/.build  (artefact output)
//   2. The compile command (pdflatex / marp / pandoc) runs inside the
//      VM with /workspace/.build as the output target.
//   3. weft-init in the guest mounts both shares before the container
//      starts and bind-mounts them into the container rootfs at the
//      same paths.
//   4. When the VM exits, scratchDir on the host contains the PDF.
//
// The -v flag was added to `weft microvm run` in weft-microvm 0.2 ;
// weft-init 0.2 parses the matching `weft.mount=virtiofs:tag:guest[:ro]`
// cmdline directives. Both ship as part of the v0.5 openweft toolchain.
func (s *Service) compileInMicroVM(ctx context.Context, workDir, scratchDir string, spec JobSpec, marp bool, engine string, command []string, emit func(Event)) (string, error) {
	bin, err := exec.LookPath("weft")
	if err != nil {
		return "", fmt.Errorf("weft CLI not on PATH ; WEFT_LOOM_BACKEND=microvm requires the openweft toolchain installed locally")
	}
	image := imageForLanguage(spec.Language, engine, marp)
	if image == "" {
		return "", fmt.Errorf("no microVM image registered for language %q", spec.Language)
	}

	// Rewrite host-absolute paths in `command` to their in-VM
	// equivalents so pdflatex / marp / pandoc target the mounted
	// guest paths, not the host paths the subprocess builder used.
	relScratch, err := filepath.Rel(workDir, scratchDir)
	if err != nil {
		return "", fmt.Errorf("relpath scratch : %w", err)
	}
	vmScratch := "/workspace/" + filepath.ToSlash(relScratch)
	rewritten := make([]string, len(command))
	for i, a := range command {
		v := strings.ReplaceAll(a, scratchDir, vmScratch)
		v = strings.ReplaceAll(v, workDir, "/workspace")
		rewritten[i] = v
	}

	args := []string{"microvm", "run"}
	if sock := os.Getenv("WEFT_AGENT_SOCK"); sock != "" {
		args = append(args, "--socket", sock)
	}
	// CubeFS path : the OPENWEFT-NATIVE design publishes the
	// pod.ShareMount on the per-VM NATS subject
	// `weft.mounts.<vmID>` *before* the VM boots. The compile VM's
	// in-guest weft-microvm-agent subscribes there as part of its
	// normal Subscriber+ApplyFunc loop (same shape it uses for mesh
	// / sshkeys / firewall), and applies the mount via
	// cubefs.Registry.Apply.
	//
	// Why publish rather than pass --cubefs on the CLI : the agent
	// already exists, it already speaks NATS, and the publish path
	// also lets us add/remove mounts on a *running* VM (teacher
	// pushing a share to a class, switching project mid-session,
	// …). The host therefore needs zero knowledge of the CubeFS
	// masters / volume credentials.
	//
	// Hostpath fallback (-v) kicks in for single-host dev when
	// WEFT_LOOM_CUBEFS_MASTERS isn't set : the loom server runs as
	// a host process and the compile VM mounts the same dir
	// directly via virtio-fs. Identical user-visible contract.
	useCubeFS := os.Getenv("WEFT_LOOM_CUBEFS_MASTERS") != ""
	if useCubeFS {
		if os.Getenv("WEFT_LOOM_CUBEFS_VOLUME") == "" {
			return "", fmt.Errorf("WEFT_LOOM_CUBEFS_MASTERS set but WEFT_LOOM_CUBEFS_VOLUME empty")
		}
		// Pre-publish the share-mount intent on the per-VM subject.
		// The weft microvm run below uses a deterministic VM name
		// (weft-microvm-<refsafe(image)>) so the publish target
		// matches what the agent inside subscribes to.
		vmID := vmNameForImage(image)
		mount := cubefsMountForLoom()
		emit(Event{Kind: "log", Line: "publish weft.mounts." + vmID + " : cubefs " + mount.CubeFS.Volume + " → /workspace"})
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := publishCubeFSMount(ctx, vmID, mount); err != nil {
			cancel()
			return "", fmt.Errorf("nats publish mount intent : %w", err)
		}
		cancel()
	} else {
		// Hostpath fallback.
		args = append(args,
			"-v", workDir+":/workspace",
			"-v", scratchDir+":"+vmScratch,
		)
	}
	args = append(args, image, "--")
	args = append(args, rewritten...)

	emit(Event{Kind: "log", Line: "weft " + strings.Join(args, " ")})
	if err := runStreaming(ctx, bin, args, ".", emit); err != nil {
		return "", fmt.Errorf("microvm dispatch failed : %w", err)
	}

	// PDF basename : derived from the entry exactly the same way the
	// subprocess path does it.
	entry := spec.Entry
	if entry == "" {
		if spec.Language == "latex" {
			entry = "main.tex"
		} else {
			entry = "main.md"
		}
	}
	base := strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))
	pdf := filepath.Join(scratchDir, base+".pdf")
	if _, err := os.Stat(pdf); err != nil {
		return "", fmt.Errorf("microvm finished but no PDF at %s", pdf)
	}
	return pdf, nil
}

// vmNameForImage mirrors weft-microvm's refsafe() : the VM name that
// `weft microvm run <image>` registers with weft-agent. Loom needs the
// same identifier so the NATS subject we publish to matches the
// in-guest agent's subscription. Cheap byte-by-byte rewrite of every
// non-[a-zA-Z0-9_-] rune to '_' on the OCI ref, with the prefix
// "weft-microvm-" added the same way the upstream does.
func vmNameForImage(image string) string {
	out := make([]byte, 0, len(image)+len("weft-microvm-"))
	out = append(out, []byte("weft-microvm-")...)
	for i := 0; i < len(image); i++ {
		c := image[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '-', c == '_':
			out = append(out, c)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}
