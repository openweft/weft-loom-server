package lintchktex

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// requireChktex skips the test unless the chktex binary is on PATH.
// CI / dev boxes without TeX Live installed pass through without
// failing — same shape as our LSP integration tests, which skip when
// the language server isn't available.
func requireChktex(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("chktex"); err != nil {
		t.Skip("chktex not installed (apt-get install chktex / brew install chktex) — skipping")
	}
}

// TestRunChktex_MissingBinary forces the resolver to point at a
// non-existent binary + asserts the package degrades gracefully.
// This branch is the production fallback when chktex isn't installed
// on the loom-server host : the API still answers 200 with an empty
// diagnostics array.
func TestRunChktex_MissingBinary(t *testing.T) {
	orig := binaryName
	t.Cleanup(func() { binaryName = orig })
	binaryName = "chktex-definitely-not-on-path-xyz-1234"

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	diags, err := RunChktex(ctx, []byte(`Hello.  world.`))
	if err != nil {
		t.Fatalf("missing binary should not error, got %v", err)
	}
	if diags != nil {
		t.Fatalf("missing binary should return nil diagnostics, got %v", diags)
	}
	if Available() {
		t.Fatalf("Available() should be false when binary missing")
	}
}

// TestRunChktex_KnownBad feeds chktex a tiny .tex snippet that has
// the canonical "double-space after period" issue (chktex code 24 :
// `Use \. to terminate the sentence`) + asserts at least one
// diagnostic comes back.
func TestRunChktex_KnownBad(t *testing.T) {
	requireChktex(t)

	// "Hello.  world." has 2 spaces after the period — chktex flags it.
	// Also include a missing-brace-around-subscript to exercise math mode.
	bad := []byte(`\documentclass{article}
\begin{document}
Hello.  world. $x_12$
\end{document}
`)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	diags, err := RunChktex(ctx, bad)
	if err != nil {
		t.Fatalf("RunChktex: %v", err)
	}
	if len(diags) == 0 {
		t.Fatalf("expected at least one diagnostic for known-bad input")
	}
	// Sanity-check the parse : each diag should carry positive
	// line/col + a non-empty message.
	for i, d := range diags {
		if d.Line < 1 {
			t.Errorf("diag %d: non-positive line %d", i, d.Line)
		}
		if d.Col < 1 {
			t.Errorf("diag %d: non-positive col %d", i, d.Col)
		}
		if strings.TrimSpace(d.Message) == "" {
			t.Errorf("diag %d: empty message", i)
		}
		if d.Severity == "" {
			t.Errorf("diag %d: empty severity", i)
		}
	}
}

// TestRunChktex_Clean checks that a well-formed snippet produces no
// "error"-severity diagnostics. We don't assert len(diags)==0
// because chktex has plenty of opinionated style nits ("Don't use
// \\@.", "Inter-sentence spacing should be …") that fire even on
// trivial input — the contract is just that nothing comes back as
// hard error.
func TestRunChktex_Clean(t *testing.T) {
	requireChktex(t)

	clean := []byte(`\documentclass{article}
\begin{document}
Hello world.
\end{document}
`)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	diags, err := RunChktex(ctx, clean)
	if err != nil {
		t.Fatalf("RunChktex: %v", err)
	}
	for _, d := range diags {
		if d.Severity == "error" {
			t.Errorf("clean input produced error-severity diag : %+v", d)
		}
	}
}

// TestParseChktexOutput exercises the line-parser directly so the
// chktex-format contract is covered even when the binary isn't
// installed on the host.
func TestParseChktexOutput(t *testing.T) {
	in := []byte(`-:3:7:24:Use \. to end sentences before capital letters.
-:5:1:1:Command terminated with space.
not-a-valid-line
-:bad:1:1:bad line
`)
	got := parseChktexOutput(in)
	if len(got) != 2 {
		t.Fatalf("expected 2 diagnostics, got %d : %+v", len(got), got)
	}
	if got[0].Line != 3 || got[0].Col != 7 || got[0].Code != 24 {
		t.Errorf("first diag fields wrong : %+v", got[0])
	}
	if !strings.Contains(got[0].Message, "end sentences") {
		t.Errorf("first diag message lost : %q", got[0].Message)
	}
	if got[1].Code != 1 || got[1].Severity != "warning" {
		t.Errorf("second diag fields wrong : %+v", got[1])
	}
}

// TestSeverityForCode locks the code→severity bucket mapping so a
// future tweak doesn't silently change the editor's red/yellow/blue
// distribution.
func TestSeverityForCode(t *testing.T) {
	cases := []struct {
		code int
		want string
	}{
		{0, "warning"},
		{1, "warning"},
		{24, "warning"},
		{99, "warning"},
		{100, "info"},
		{200, "info"},
	}
	for _, c := range cases {
		if got := severityForCode(c.code); got != c.want {
			t.Errorf("severityForCode(%d) = %q, want %q", c.code, got, c.want)
		}
	}
}
