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
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// imageForLanguage picks the OCI image weft-microvm pulls for a
// given language. The images bundle the toolchain pre-installed so
// the VM boots ready to compile.
func imageForLanguage(language string, marp bool) string {
	// Allow per-cluster override via env so an air-gapped install can
	// point at a private registry.
	switch language {
	case "latex":
		if v := os.Getenv("WEFT_LOOM_IMAGE_LATEX"); v != "" {
			return v
		}
		return "ghcr.io/openweft/weft-loom-texlive:latest"
	case "markdown":
		// One image covers BOTH marp + pandoc. The runtime picks the
		// binary based on the front-matter ; weft-agent only pulls
		// one OCI artifact for any markdown source.
		_ = marp
		if v := os.Getenv("WEFT_LOOM_IMAGE_MARKDOWN"); v != "" {
			return v
		}
		return "ghcr.io/openweft/weft-loom-markdown:latest"
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
func (s *Service) compileInMicroVM(workDir, scratchDir string, spec JobSpec, marp bool, command []string, emit func(Event)) (string, error) {
	bin, err := exec.LookPath("weft")
	if err != nil {
		return "", fmt.Errorf("weft CLI not on PATH ; WEFT_LOOM_BACKEND=microvm requires the openweft toolchain installed locally")
	}
	image := imageForLanguage(spec.Language, marp)
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
	// Prefer the CubeFS path when configured : both loom-server and
	// the compile VM see the same shared volume directly via cfs-client
	// in the initramfs. No hostpath round-trip, no per-replica copies.
	//
	// WEFT_LOOM_CUBEFS_MASTERS = "m1:port,m2:port,m3:port"
	// WEFT_LOOM_CUBEFS_VOLUME  = "loom-projects"
	// WEFT_LOOM_CUBEFS_SUBPATH = optional prefix inside the volume that
	//                            maps to "/workspace" inside the VM ;
	//                            defaults to "/" (volume root).
	if masters := os.Getenv("WEFT_LOOM_CUBEFS_MASTERS"); masters != "" {
		volume := os.Getenv("WEFT_LOOM_CUBEFS_VOLUME")
		if volume == "" {
			return "", fmt.Errorf("WEFT_LOOM_CUBEFS_MASTERS set but WEFT_LOOM_CUBEFS_VOLUME empty")
		}
		args = append(args, "--cubefs", masters+":"+volume+":/workspace")
	} else {
		// Hostpath fallback : useful in single-host dev where the loom
		// server runs as a host process and the project tree is on the
		// local fs.
		args = append(args,
			"-v", workDir+":/workspace",
			"-v", scratchDir+":"+vmScratch,
		)
	}
	args = append(args, image, "--")
	args = append(args, rewritten...)

	emit(Event{Kind: "log", Line: "weft " + strings.Join(args, " ")})
	if err := runStreaming(bin, args, ".", emit); err != nil {
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
