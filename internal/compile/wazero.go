package compile

// wazero.go — the fourth compile dispatch path : run the pure-Go gotex
// engine, compiled once to WebAssembly (GOOS=wasip1 GOARCH=wasm), inside
// the pure-Go wazero runtime. In-process, sandboxed, CGO=0 : no subprocess,
// no TeX Live, and no external `gotex` binary on the host PATH. This is the
// server-side mirror of running the very same gotex.wasm artifact in a
// browser Web Worker — "one artifact, two hosts".
//
// fork/exec is "not implemented on wasm", so this path structurally cannot
// spawn a subprocess : the engine has to be a linked-in wasm module driven
// by wazero, which is exactly the point.
//
// Opt-in, like the microVM path : WEFT_LOOM_BACKEND=wazero (see useWazero)
// and only for engine=gotex — the TeX Live engines have no wasm build. The
// 7.5 MB module is NOT embedded in the loom-server binary for this
// prototype ; its path is read from WEFT_LOOM_GOTEX_WASM. When that env is
// empty the path returns a clear error rather than guessing.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	"github.com/tetratelabs/wazero/sys"
)

// useWazero reports whether the operator selected the in-process wasm
// dispatch. Opt-in exactly like useMicroVM : WEFT_LOOM_BACKEND=wazero. Only
// meaningful for the gotex engine.
func useWazero() bool {
	return strings.ToLower(os.Getenv("WEFT_LOOM_BACKEND")) == "wazero"
}

// gotexWasmPath returns the configured path to the gotex.wasm module (a
// GOOS=wasip1 GOARCH=wasm build of github.com/go-tex/engine/cmd/gotex), or
// "" when WEFT_LOOM_GOTEX_WASM is unset.
func gotexWasmPath() string {
	return os.Getenv("WEFT_LOOM_GOTEX_WASM")
}

// compileInWazero runs `command` (a gotex argv produced by latexCommand) by
// instantiating gotex.wasm under wazero, with workDir mounted read-write at
// /workspace. Host-absolute paths in the argv are rewritten to their guest
// equivalents exactly the way compileInMicroVM rewrites them for the microVM
// bind mounts, so gotex writes the PDF into the mounted scratch dir. stdout
// and stderr are captured and streamed to the compile log as "log" events.
// Returns the PDF path under scratchDir, matching the other dispatch paths.
func compileInWazero(ctx context.Context, workDir, scratchDir string, spec JobSpec, command []string, emit func(Event)) (string, error) {
	wasmPath := gotexWasmPath()
	if wasmPath == "" {
		return "", errors.New("WEFT_LOOM_BACKEND=wazero requires WEFT_LOOM_GOTEX_WASM to point at a gotex.wasm module (build it with `GOOS=wasip1 GOARCH=wasm go build -o gotex.wasm ./cmd/gotex` in github.com/go-tex/engine)")
	}
	wasmBytes, err := os.ReadFile(wasmPath)
	if err != nil {
		return "", fmt.Errorf("read gotex.wasm (%s) : %w", wasmPath, err)
	}

	// Host→guest path rewrite : workDir is mounted at /workspace, so scratchDir
	// (which lives under workDir) maps onto /workspace/<rel>. This mirrors the
	// strings.ReplaceAll rewrite compileInMicroVM performs so the guest engine
	// targets the mounted paths, not the host paths latexCommand baked in.
	relScratch, err := filepath.Rel(workDir, scratchDir)
	if err != nil {
		return "", fmt.Errorf("relpath scratch : %w", err)
	}
	guestScratch := "/workspace/" + filepath.ToSlash(relScratch)
	guestArgs := make([]string, len(command))
	for i, a := range command {
		v := strings.ReplaceAll(a, scratchDir, guestScratch)
		v = strings.ReplaceAll(v, workDir, "/workspace")
		guestArgs[i] = v
	}

	emit(Event{Kind: "log", Line: fmt.Sprintf(
		"wazero gotex.wasm (%.1f MB, in-process, sandboxed) : %s",
		float64(len(wasmBytes))/1e6, strings.Join(guestArgs, " "),
	)})

	// Pure-Go wasm runtime. No cgo, no external process. Closed on return so
	// the compiled module + its memory are released once the job finishes.
	r := wazero.NewRuntime(ctx)
	defer r.Close(ctx)
	wasi_snapshot_preview1.MustInstantiate(ctx, r)

	var stdout, stderr bytes.Buffer
	cfg := wazero.NewModuleConfig().
		WithFSConfig(wazero.NewFSConfig().WithDirMount(workDir, "/workspace")).
		WithArgs(guestArgs...).
		WithStdout(&stdout).
		WithStderr(&stderr)

	// InstantiateWithConfig runs the module's _start (main). A clean exit
	// returns nil ; a non-zero os.Exit surfaces as *sys.ExitError, which we
	// unwrap for the exit code rather than treating as a hard failure.
	code := 0
	if _, ierr := r.InstantiateWithConfig(ctx, wasmBytes, cfg); ierr != nil {
		var exit *sys.ExitError
		if errors.As(ierr, &exit) {
			code = int(exit.ExitCode())
		} else {
			return "", fmt.Errorf("wazero instantiate gotex.wasm : %w", ierr)
		}
	}

	// Stream whatever gotex printed, one Event per line, so the user sees the
	// engine's output next to the other backends' logs.
	for _, line := range splitLogLines(stdout.String()) {
		emit(Event{Kind: "log", Line: line})
	}
	for _, line := range splitLogLines(stderr.String()) {
		emit(Event{Kind: "log", Line: line})
	}
	if code != 0 {
		return "", fmt.Errorf("gotex.wasm exited with code %d", code)
	}

	// Derive the produced PDF exactly like the subprocess / microVM paths :
	// <scratchDir>/<entry-basename>.pdf.
	entry := spec.Entry
	if entry == "" {
		entry = "main.tex"
	}
	base := strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))
	pdf := filepath.Join(scratchDir, base+".pdf")
	if _, serr := os.Stat(pdf); serr != nil {
		return "", fmt.Errorf("gotex.wasm finished but no PDF at %s", pdf)
	}
	return pdf, nil
}

// splitLogLines splits captured output into individual, trailing-newline-free
// lines, returning nil for empty output so no blank Event is emitted.
func splitLogLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}
