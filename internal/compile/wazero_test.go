package compile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestUseWazero covers the backend selector : only the exact
// WEFT_LOOM_BACKEND=wazero value (case-insensitive) opts in.
func TestUseWazero(t *testing.T) {
	cases := map[string]bool{
		"wazero":  true,
		"WAZERO":  true,
		"WaZeRo":  true,
		"microvm": false,
		"":        false,
		"wasm":    false,
	}
	for val, want := range cases {
		t.Setenv("WEFT_LOOM_BACKEND", val)
		if got := useWazero(); got != want {
			t.Errorf("useWazero() with WEFT_LOOM_BACKEND=%q = %v, want %v", val, got, want)
		}
	}
}

// TestCompileInWazeroMissingWasm asserts the path fails with a clear,
// actionable error when WEFT_LOOM_GOTEX_WASM is unset — no wasm module
// required, so this always runs.
func TestCompileInWazeroMissingWasm(t *testing.T) {
	t.Setenv("WEFT_LOOM_GOTEX_WASM", "")
	workDir := t.TempDir()
	scratchDir := filepath.Join(workDir, ".weft-loom", "job")
	if err := os.MkdirAll(scratchDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := latexCommand("gotex", filepath.Join(workDir, "main.tex"), scratchDir, nil, true)
	_, err := compileInWazero(context.Background(), workDir, scratchDir, JobSpec{}, cmd, discard)
	if err == nil {
		t.Fatal("expected error when WEFT_LOOM_GOTEX_WASM is unset, got nil")
	}
	if !strings.Contains(err.Error(), "WEFT_LOOM_GOTEX_WASM") {
		t.Errorf("error should mention WEFT_LOOM_GOTEX_WASM, got : %v", err)
	}
}

// TestCompileInWazeroProducesPDF is the load-bearing verification : it runs
// the real gotex.wasm module under wazero, in-process, and checks that a
// non-empty PDF is produced from a minimal LaTeX document — no TeX Live, no
// external gotex binary, no subprocess.
//
// The wasm module is supplied via WEFT_LOOM_GOTEX_WASM (built once with
// `GOOS=wasip1 GOARCH=wasm go build -o gotex.wasm ./cmd/gotex` in
// github.com/go-tex/engine). When it is unset or missing the test skips
// cleanly, since loom-server's module does not depend on go-tex/engine and
// therefore cannot build the wasm itself.
func TestCompileInWazeroProducesPDF(t *testing.T) {
	wasmPath := os.Getenv("WEFT_LOOM_GOTEX_WASM")
	if wasmPath == "" {
		t.Skip("WEFT_LOOM_GOTEX_WASM unset ; build gotex.wasm (GOOS=wasip1 GOARCH=wasm go build -o gotex.wasm ./cmd/gotex in github.com/go-tex/engine) and point the env at it to run this test")
	}
	if _, err := os.Stat(wasmPath); err != nil {
		t.Skipf("WEFT_LOOM_GOTEX_WASM=%s not readable : %v", wasmPath, err)
	}

	workDir := t.TempDir()
	entryAbs := filepath.Join(workDir, "main.tex")
	const doc = `\documentclass{article}
\begin{document}
Hello from gotex running under wazero, in-process and sandboxed.
\end{document}
`
	if err := os.WriteFile(entryAbs, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	// Scratch dir lives under the working tree, exactly like the production
	// run() path lays it out.
	scratchDir := filepath.Join(workDir, ".weft-loom", "testjob")
	if err := os.MkdirAll(scratchDir, 0o755); err != nil {
		t.Fatal(err)
	}

	var logs []string
	emit := func(ev Event) {
		if ev.Kind == "log" {
			logs = append(logs, ev.Line)
		}
	}

	spec := JobSpec{Language: "latex", Engine: "gotex", Entry: "main.tex"}
	cmd := latexCommand("gotex", entryAbs, scratchDir, nil, true)
	pdf, err := compileInWazero(context.Background(), workDir, scratchDir, spec, cmd, emit)
	if err != nil {
		t.Fatalf("compileInWazero failed : %v\nlogs:\n%s", err, strings.Join(logs, "\n"))
	}

	if pdf != filepath.Join(scratchDir, "main.pdf") {
		t.Errorf("unexpected PDF path %q", pdf)
	}
	data, err := os.ReadFile(pdf)
	if err != nil {
		t.Fatalf("read produced PDF : %v", err)
	}
	if len(data) == 0 {
		t.Fatal("produced PDF is empty")
	}
	if !strings.HasPrefix(string(data), "%PDF-") {
		t.Errorf("produced file is not a PDF (no %%PDF- header), first bytes : %q", string(data[:min(16, len(data))]))
	}
	t.Logf("gotex.wasm under wazero produced %s : %d bytes", pdf, len(data))
}

// discard is a no-op event sink for tests that don't inspect the log stream.
func discard(Event) {}
