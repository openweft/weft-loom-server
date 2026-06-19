// Package lintchktex shells out to the standalone `chktex` binary
// to surface strict LaTeX style diagnostics on top of what texlab
// already reports through the LSP bridge.
//
// chktex catches issues texlab doesn't (sentence-end-without-space,
// missing braces around super/sub-scripts, ellipsis in math mode,
// etc.) — the kind of things Overleaf surfaces inline. We pipe the
// document content on stdin so there's no temp file dance and the
// caller doesn't have to expose a project path.
//
// Graceful degradation : if the binary isn't on $PATH we return
// `(nil, nil)`. That makes the calling endpoint a no-op rather than
// an error — the editor's gutter still works, just without the
// stricter warnings. Same shape as AvailableLanguages in internal/lsp.
//
// Wire shape (chktex CLI) :
//
//	chktex -q -f "%f:%l:%c:%n:%m\n"
//
// Reads stdin when no file argument is given. The output format
// pieces are :
//
//	%f : filename (we feed "-", so it's literal "-")
//	%l : line   (1-based)
//	%c : column (1-based)
//	%n : warning code (numeric)
//	%m : message
//
// Each line is one finding. We map the numeric code to LSP-flavoured
// severity buckets ("error" / "warning" / "info") via the chktex
// severity table — message numbers above 2000 are typically style
// nits ; the bulk live in 1xxx (warnings).
package lintchktex

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Diagnostic is the LSP-flavoured shape the server hands back to the
// SPA. Mirrors the on-wire JSON the editor's lint extension already
// consumes for LSP diagnostics — line/col are 1-based to match how
// chktex emits them ; the SPA translates to CodeMirror's 0-based
// document offsets the same way it does for the LSP bridge.
type Diagnostic struct {
	Line     int    `json:"line"`     // 1-based line number
	Col      int    `json:"col"`      // 1-based column
	Code     int    `json:"code"`     // chktex warning code (numeric)
	Message  string `json:"message"`  // human-readable text
	Severity string `json:"severity"` // "error" | "warning" | "info"
}

// binaryName is the resolved chktex executable. Var so tests can
// stub it out if needed ; default looks up "chktex" on PATH.
var binaryName = "chktex"

// Available reports whether the chktex binary is resolvable on the
// host. Used by the HTTP layer to short-circuit the request when
// chktex isn't installed (returns an empty diagnostics array rather
// than a 503).
func Available() bool {
	_, err := exec.LookPath(binaryName)
	return err == nil
}

// RunChktex pipes `content` into chktex on stdin + parses the
// diagnostic lines off stdout. Returns (nil, nil) when chktex isn't
// installed — callers should treat the empty result as "no strict
// linter available, show nothing". A non-nil error means we found
// the binary but couldn't drive it (pipe failure, ctx cancellation,
// unparseable output).
//
// `content` is the full .tex source — chktex needs the whole file
// because many of its checks are multi-line (paragraph end, math
// mode tracking, …). We never truncate ; if the upload limit needs
// enforcing it belongs at the HTTP layer, not here.
func RunChktex(ctx context.Context, content []byte) ([]Diagnostic, error) {
	bin, err := exec.LookPath(binaryName)
	if err != nil {
		// Missing binary — gracefully degrade per the package doc.
		return nil, nil
	}

	// -q : quiet (no banner)
	// -f : format spec ; "%f:%l:%c:%n:%m\n" puts everything we need
	//      on a single line so the parser is a one-shot split.
	// "-" : filename arg → chktex reads stdin instead of opening a file.
	cmd := exec.CommandContext(ctx, bin, "-q", "-f", "%f:%l:%c:%n:%m\n", "-")
	cmd.Stdin = bytes.NewReader(content)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// chktex returns non-zero when it found warnings — that's the
	// *expected* path here, not a failure. We only surface errors
	// when stdout is empty AND something useful is on stderr.
	if err := cmd.Run(); err != nil {
		// ExitError with stdout content = warnings were found ; not
		// a process failure. Any other error (spawn failure, context
		// cancellation) propagates.
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return nil, fmt.Errorf("chktex: run: %w", err)
		}
		if stdout.Len() == 0 && stderr.Len() > 0 {
			return nil, fmt.Errorf("chktex: %s", strings.TrimSpace(stderr.String()))
		}
	}

	return parseChktexOutput(stdout.Bytes()), nil
}

// parseChktexOutput chops the stdout buffer into Diagnostic records.
// Lines that don't match the 5-field format are dropped silently so
// we don't choke on chktex's occasional banner / version line if a
// future release re-introduces one despite -q.
func parseChktexOutput(buf []byte) []Diagnostic {
	out := make([]Diagnostic, 0, 8)
	sc := bufio.NewScanner(bytes.NewReader(buf))
	// chktex messages can be long ; lift the default 64KiB cap.
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		// Format : <file>:<line>:<col>:<code>:<message>
		// The message may itself contain colons, so SplitN with N=5.
		parts := strings.SplitN(line, ":", 5)
		if len(parts) != 5 {
			continue
		}
		ln, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		col, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		code, err := strconv.Atoi(parts[3])
		if err != nil {
			continue
		}
		out = append(out, Diagnostic{
			Line:     ln,
			Col:      col,
			Code:     code,
			Message:  strings.TrimSpace(parts[4]),
			Severity: severityForCode(code),
		})
	}
	return out
}

// severityForCode maps chktex's numeric warning code to one of the
// 3 LSP severity buckets the SPA's lint extension renders. chktex
// itself groups its checks into "Error", "Warning", "Message" in
// chktexrc — we approximate with a coarse code-range bucket :
//
//	1   .. 99   : "warning" — most lexical / typographical checks
//	100 .. 199  : "info"    — style nits (often spacing / hyphens)
//	200+        : "info"    — non-default tightenings
//
// Erroneous-looking constructs (unmatched delimiters, ill-formed
// commands) live in the low single digits — bumping those to "error"
// would put red squiggles on harmless paragraphs in many docs, so
// we keep the whole table at warning/info by default. Future work :
// expose the mapping via config if users want a stricter palette.
func severityForCode(code int) string {
	switch {
	case code <= 0:
		return "warning"
	case code < 100:
		return "warning"
	default:
		return "info"
	}
}
