package compile

// compile_workspace.go — the unified compile dispatch. Same NATS
// subjects the user's shell tab uses ; texlive, marp, go, pandoc
// are all "containers" picked at runtime via the language → image
// resolver. No more special-treatment branches per language —
// adding a new compiler is a one-line entry in imageForLanguage.
//
// Flow per job :
//
//   1. resolve image for language (texlive / markdown / …)
//   2. publish weft.containers.<vmID> ensuring the container is
//      pulled + running with Restart=always (kept warm)
//   3. open weft.exec.<vmID>.<sid> with kind=exec + container name
//      + the compiler argv ; subscribe to its out subject
//   4. accumulate 'o' frames as log lines, surface to the event
//      channel ; on 'e' exit frame, treat exit code 0 as success
//   5. artifact path = <workDir>/.build/<basename(input)>.pdf
//
// In dev mode (in-process devagent) the container layer is a no-op :
// the devagent's kind=exec path just runs the argv on the host PATH
// with WorkDir set. Same wire, different backend — the only
// observable difference is faster startup.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/openweft/weft-microvm-init/pkg/pod"
	execsession "github.com/openweft/weft-microvm-agent/pkg/execsession"
)

// resolveVMForCompile asks the workspace resolver for the user's
// VM. Returns nil when the resolver isn't wired (compile-only dev
// without the workspace path) OR when the VM has no NATS conn
// (host-pty fallback mode) OR when the operator explicitly disabled
// the workspace compile path (default in V0.5 because the dev
// Alpine rootfs ships without crun + the tool container images
// aren't yet on GHCR ; a compile dispatched to such a VM would
// silently hang waiting for an exec the guest can't perform).
//
// Set WEFT_LOOM_USE_WORKSPACE_COMPILE=1 once the workspace base
// qcow2 carries crun + the tool images are reachable.
func (s *Service) resolveVMForCompile(spec JobSpec) *WorkspaceVM {
	if os.Getenv("WEFT_LOOM_USE_WORKSPACE_COMPILE") != "1" {
		return nil
	}
	if s.Workspaces == nil {
		return nil
	}
	vm, err := s.Workspaces.Ensure(context.Background(), WorkspaceIdentity{Subject: spec.Identity})
	if err != nil || vm == nil || vm.Conn == nil {
		return nil
	}
	return vm
}

// containerNameForLanguage maps a language to the stable container
// name the workspace VM keeps running. Same names the
// tool-wrappers in weft-loom-workspace shell out to via
// `crun exec <name>`.
func containerNameForLanguage(language string) string {
	switch language {
	case "latex":
		return "texlive"
	case "markdown":
		return "markdown"
	case "golang", "go":
		return "golang"
	case "python":
		return "python"
	case "rust":
		return "rust"
	case "node", "javascript", "typescript":
		return "node"
	case "cpp", "c++", "c":
		return "cpp"
	case "shell", "bash", "sh":
		// Shell scripts run in the workspace μVM's host shell — no
		// dedicated container. The exec session targets the host
		// (apptainer fallback : the empty container name routes
		// the command through the host /bin/sh).
		return "host"
	case "ruby":
		return "ruby"
	case "perl":
		return "perl"
	}
	return ""
}

// compileInWorkspace runs the compile on the user's workspace VM
// via NATS exec. Returns the artifact path under workDir/.build.
//
// The caller owns the working tree on the host (the project store
// already laid it down). In dev mode the VM's "/workspace" is the
// host workDir, so the artifact is materialised in-place ; in
// prod the VM's CubeFS share IS the workDir on the host, same
// result.
func (s *Service) compileInWorkspace(
	ctx context.Context,
	vm *WorkspaceVM,
	workDir string,
	language string,
	command []string,
	emit func(Event),
) (string, error) {
	if vm == nil || vm.Conn == nil {
		return "", fmt.Errorf("workspace not connected")
	}
	container := containerNameForLanguage(language)
	if container == "" {
		return "", fmt.Errorf("no container name for language %q", language)
	}

	// Instrumentation : measure each pipeline step so the user can see
	// where the wall-clock goes. Emitted as `log` events so they show
	// up in the SPA compile panel right next to the pdflatex output.
	t0 := time.Now()
	stamp := func(label string) {
		emit(Event{Kind: "log", Line: fmt.Sprintf("⏱  %-22s %6dms", label, time.Since(t0).Milliseconds())})
	}
	stamp("server.dispatch.start")

	// Step 2 : ensure the tool container is in the desired set. We
	// publish a singleton set so the reconciler converges to "just
	// this one container running" for now ; multi-container worksets
	// (texlive + markdown both warm, picked per file) land when the
	// compile router learns to introspect open files.
	image := imageForLanguage(language, false)
	setMsg, err := json.Marshal(pod.ContainerSet{
		Version: pod.ContainerSetVersion,
		Containers: []pod.WorkloadContainer{{
			Name:    container,
			Image:   image,
			Restart: "always",
			Net:     "host",
			Mounts: []pod.ContainerMount{{
				HostPath:  workDir,
				MountPath: "/workspace",
			}},
			WorkingDir: "/workspace",
		}},
	})
	if err != nil {
		return "", fmt.Errorf("marshal container set: %w", err)
	}
	if err := vm.Conn.Publish("weft.containers."+vm.VMID, setMsg); err != nil {
		return "", fmt.Errorf("publish containers: %w", err)
	}
	stamp("server.containers.published")

	// Step 3 : open exec session for the compile command.
	sid := newJobID() // reuse the job-ID generator
	outSubject := execsession.SubjectOut(vm.VMID, sid)
	inSubject := execsession.SubjectIn(vm.VMID, sid)
	openSubject := execsession.SubjectOpen(vm.VMID)

	// Mesh I/O counters : the NATS exec channel is the mesh between
	// loom-server (host) + workspace μVM. We tally bytes published
	// out + bytes received in, plus elapsed-to-first-byte so the
	// user can see "VM cold-start" vs "compile-took-time" cleanly.
	var (
		mu        sync.Mutex
		logBuf    []byte
		exited    bool
		exitVal   uint32
		bytesOut  atomic.Uint64 // server → guest (open + stdin)
		bytesIn   atomic.Uint64 // guest → server (stdout + exit code)
		firstByte atomic.Int64  // unix-ms of first 'o' or 'e' frame
	)
	done := make(chan struct{})

	sub, err := vm.Conn.Subscribe(outSubject, func(_ string, data []byte) {
		if len(data) == 0 {
			return
		}
		bytesIn.Add(uint64(len(data)))
		firstByte.CompareAndSwap(0, time.Now().UnixMilli())
		switch data[0] {
		case 'o':
			payload := data[1:]
			mu.Lock()
			logBuf = append(logBuf, payload...)
			// Split on newlines to emit one Event per line.
			for {
				idx := indexNewline(logBuf)
				if idx < 0 {
					break
				}
				line := string(logBuf[:idx])
				logBuf = logBuf[idx+1:]
				emit(Event{Kind: "log", Line: stripCR(line)})
			}
			mu.Unlock()
		case 'e':
			if len(data) >= 5 {
				mu.Lock()
				exited = true
				exitVal = binary.BigEndian.Uint32(data[1:])
				// Flush any trailing partial line.
				if len(logBuf) > 0 {
					emit(Event{Kind: "log", Line: stripCR(string(logBuf))})
					logBuf = nil
				}
				mu.Unlock()
				close(done)
			}
		}
	})
	if err != nil {
		return "", fmt.Errorf("subscribe out: %w", err)
	}
	defer func() { _ = sub.Unsubscribe() }()
	stamp("server.subscribed.out")

	// Use kind=shell with the toolshare wrapper binary in argv[0].
	// The workspace VM's /usr/local/bin/<wrapper> does
	// `apptainer exec <sandbox> <bin>` so we don't need crun-based
	// kind=exec at all in the toolshare-pivot architecture.
	_ = container
	// Translate host paths in command + workDir to guest paths.
	// The 9p mount publishes <storage_root>/<subject>/ at /workspace
	// inside the guest, so any host path under workDir maps 1:1
	// onto /workspace/<basename(workDir)>/<rel>. We also handle
	// `-flag=path` style args (pdflatex/latexmk use these) by
	// translating the value half of the first `=`.
	guestProjectDir := "/workspace/" + filepath.Base(workDir)
	translateArg := func(arg string) string {
		if filepath.IsAbs(arg) {
			if rel, err := filepath.Rel(workDir, arg); err == nil && !strings.HasPrefix(rel, "..") {
				return filepath.Join(guestProjectDir, rel)
			}
			return arg
		}
		if eq := strings.IndexByte(arg, '='); eq > 0 {
			flag, val := arg[:eq], arg[eq+1:]
			if filepath.IsAbs(val) {
				if rel, err := filepath.Rel(workDir, val); err == nil && !strings.HasPrefix(rel, "..") {
					return flag + "=" + filepath.Join(guestProjectDir, rel)
				}
			}
		}
		return arg
	}
	translated := make([]string, len(command))
	for i, arg := range command {
		translated[i] = translateArg(arg)
	}
	openMsg, err := json.Marshal(execsession.ExecRequest{
		ID: sid,
		Target: execsession.ExecTarget{
			Kind:    "shell",
			Command: translated,
			WorkDir: guestProjectDir,
		},
	})
	if err != nil {
		return "", fmt.Errorf("marshal open: %w", err)
	}
	bytesOut.Add(uint64(len(openMsg)) + uint64(len("weft.containers.")) + uint64(len(setMsg)))
	if err := vm.Conn.Publish(openSubject, openMsg); err != nil {
		return "", fmt.Errorf("publish open: %w", err)
	}
	stamp("server.exec.open.published")

	// Wait for exit OR context timeout.
	select {
	case <-done:
	case <-ctx.Done():
		_ = vm.Conn.Publish(inSubject, []byte{'x'})
		return "", ctx.Err()
	}
	stamp("server.exec.exit.received")

	mu.Lock()
	defer mu.Unlock()

	// Final throughput + I/O report. Bytes on the mesh come straight
	// from the NATS counters ; bytes written to the /workspace share
	// come from stat()ing the artifact directory after the compile.
	// This gives the user a per-step breakdown they can compare with
	// the on-screen wall-clock.
	totalMs := time.Since(t0).Milliseconds()
	firstByteMs := firstByte.Load() - t0.UnixMilli()
	if firstByte.Load() == 0 {
		firstByteMs = -1
	}
	in, out := bytesIn.Load(), bytesOut.Load()
	emit(Event{Kind: "log", Line: fmt.Sprintf(
		"⏱  mesh   in=%6dB  out=%6dB  first-byte=%6dms  total=%6dms",
		in, out, firstByteMs, totalMs,
	)})

	// Workspace share I/O : stat the per-job output dir. The compile
	// writes there via the apptainer --bind /workspace bridge, so
	// the total bytes are an upper bound for "what the guest wrote
	// through 9p". Tools writing to /tmp inside the container don't
	// count (they stay in tmpfs).
	//
	// artifactPath = the actual PDF on disk : pdflatex with
	// `-output-directory=<scratch>` writes <scratch>/<entry>.pdf, not
	// <workDir>/<entry>.pdf — so we honour the operator's
	// -output-directory when present. Fallback to workDir when no
	// -output-directory is set (latexmk / direct invocations).
	//
	// The "entry" name comes from the LAST non-flag arg : argv[0] is
	// the binary (pdflatex, marp, pandoc) ; the last positional is
	// the input file. Using firstArg() picked up "pdflatex" instead
	// of "main.tex" — symptom : /artifact 404 because pdflatex.pdf
	// never existed.
	entry := entryArg(command)
	base := strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))
	outDir := pickOutputDir(command, workDir)
	if outDir == "" {
		outDir = workDir
	}
	artifactPath := filepath.Join(outDir, base+".pdf")
	var shareBytes int64
	if outDir != workDir {
		shareBytes = dirSize(outDir)
	}
	if shareBytes == 0 {
		if st, statErr := os.Stat(artifactPath); statErr == nil {
			shareBytes = st.Size()
		}
	}
	emit(Event{Kind: "log", Line: fmt.Sprintf(
		"⏱  share  workspace.bytes_written=%dB  artifact=%s",
		shareBytes, filepath.Base(artifactPath),
	)})

	if !exited || exitVal != 0 {
		return "", fmt.Errorf("compile exited with code %d", exitVal)
	}

	// Step 5 : artifact path. We trust the per-language convention
	// (pdflatex → main.pdf, marp → main.pdf, pandoc → main.pdf) for
	// now ; a follow-up will let the SPA pass an explicit target.
	return artifactPath, nil
}

// pickOutputDir scans for `-output-directory=<path>` (pdflatex /
// latexmk convention) and returns the absolute host path. Empty
// when not present (the compile wrote to workDir directly).
func pickOutputDir(command []string, workDir string) string {
	for _, arg := range command {
		if !strings.HasPrefix(arg, "-output-directory=") {
			continue
		}
		v := strings.TrimPrefix(arg, "-output-directory=")
		if filepath.IsAbs(v) {
			return v
		}
		return filepath.Join(workDir, v)
	}
	return ""
}

// entryArg returns the LAST non-flag arg in argv. For
// `[pdflatex -interaction=... -output-directory=... main.tex]` it
// returns "main.tex". Distinct from firstArg(), which would return
// "pdflatex" — the binary name, not the input file.
func entryArg(argv []string) string {
	for i := len(argv) - 1; i >= 0; i-- {
		a := argv[i]
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	if len(argv) > 0 {
		return argv[len(argv)-1]
	}
	return "main"
}

// dirSize sums regular file sizes one level deep. Sufficient for the
// compile artifact dir which is flat (main.pdf, main.log, main.aux,
// main.out).
func dirSize(dir string) int64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if info, err := e.Info(); err == nil {
			total += info.Size()
		}
	}
	return total
}

func indexNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

func stripCR(s string) string {
	return strings.TrimRight(s, "\r")
}

func firstArg(argv []string) string {
	for _, a := range argv {
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	if len(argv) > 0 {
		return argv[0]
	}
	return "main"
}
