package server

// tool_warmup.go — proactive tool-container warm-up. Every time the
// SPA opens a file with a recognised extension we publish the
// matching weft-loom-<tool> container into the user's workspace VM
// containers set, so by the time the user hits "Compile" the
// container is already pulled + running. Symmetric for every tool —
// no special treatment per language (texlive == markdown == go).
//
// Hook : handleReadFile calls warmContainerForFile after a successful
// read. Idempotent : if the container is already in the desired set
// the agent's reconciler is a no-op.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"

	"github.com/openweft/weft-microvm-init/pkg/pod"

	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/workspace"
)

// containerForExtension picks the warmup container name + image for a
// file extension. Returns ("", "") to skip warmup (file isn't a
// known compileable artefact).
//
// Image refs match the published `openweft/weft-loom-*` repos
// (cross-referenced against each repo's build.yml on 2026-06-10).
// Container name within the workspace VM is short + ASCII so the
// tool-wrapper scripts in weft-loom-workspace can `crun exec <name>`
// without quoting headaches.
func containerForExtension(ext string) (name, image string) {
	switch strings.ToLower(ext) {
	case ".tex", ".sty", ".cls", ".bib":
		return "texlive", "ghcr.io/openweft/weft-loom-texlive:latest"
	case ".md", ".markdown":
		return "markdown", "ghcr.io/openweft/weft-loom-markdown:latest"
	case ".go":
		return "golang", "ghcr.io/openweft/weft-loom-golang:latest"
	case ".py":
		return "python", "ghcr.io/openweft/weft-loom-python:latest"
	case ".rs":
		return "rust", "ghcr.io/openweft/weft-loom-rust:latest"
	case ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs":
		return "node", "ghcr.io/openweft/weft-loom-node:latest"
	case ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp":
		return "cpp", "ghcr.io/openweft/weft-loom-cpp:latest"
	}
	return "", ""
}

// warmupState tracks the per-VM desired container set so we don't
// re-publish on every file read. Concurrent-safe.
type warmupState struct {
	mu  sync.Mutex
	set map[string]map[string]string // vmID → containerName → image
}

func newWarmupState() *warmupState {
	return &warmupState{set: map[string]map[string]string{}}
}

// addContainer registers (vmID, name, image) in the desired set ;
// returns the full set + whether anything actually changed (so the
// caller can skip the publish on no-op).
func (w *warmupState) addContainer(vmID, name, image string) (current map[string]string, changed bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	got, ok := w.set[vmID]
	if !ok {
		got = map[string]string{}
		w.set[vmID] = got
	}
	if existing, present := got[name]; present && existing == image {
		return copyStringMap(got), false
	}
	got[name] = image
	return copyStringMap(got), true
}

func copyStringMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// warmContainerForFile publishes the matching tool container into
// the user's workspace VM when path's extension is recognised.
// Best-effort : a NATS publish failure is logged but never gates
// the file read it piggybacks on.
func (s *Server) warmContainerForFile(
	ctx context.Context,
	vm *workspace.VM,
	project, path string,
) {
	if vm == nil || vm.Conn == nil {
		return
	}
	name, image := containerForExtension(filepath.Ext(path))
	if name == "" {
		return
	}
	set, changed := s.warmups.addContainer(vm.VMID, name, image)
	if !changed {
		return
	}
	// Build the ContainerSet whole : the reconciler reads it
	// declaratively, so partial publishes would teardown unrelated
	// containers. Workspace mount is always /workspace ; the host
	// path differs per backend but the guest path is stable.
	containers := make([]pod.WorkloadContainer, 0, len(set))
	for cname, cimage := range set {
		containers = append(containers, pod.WorkloadContainer{
			Name:    cname,
			Image:   cimage,
			Restart: "always",
			Net:     "host",
			Mounts: []pod.ContainerMount{{
				HostPath:  "/workspace",
				MountPath: "/workspace",
			}},
			WorkingDir: "/workspace",
		})
	}
	payload, err := json.Marshal(pod.ContainerSet{
		Version:    pod.ContainerSetVersion,
		Containers: containers,
	})
	if err != nil {
		return
	}
	if err := vm.Conn.Publish("weft.containers."+vm.VMID, payload); err != nil {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "warmup", Verb: "publish.err",
			Level:   "warn",
			Project: project,
			Fields:  map[string]any{"vm_id": vm.VMID, "container": name, "err": err.Error()},
		})
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "warmup", Verb: "container.ensured",
		Project: project,
		Fields:  map[string]any{"vm_id": vm.VMID, "container": name, "image": image, "trigger": "file.read", "path": path},
	})
}
