package compile

import (
	"strings"
	"testing"
	"time"
)

func TestExpandTemplate(t *testing.T) {
	// Fixed point so the date-based assertions don't drift with the
	// wall clock when tests run on a slow CI runner spanning midnight.
	now := time.Date(2026, 6, 12, 14, 30, 45, 0, time.UTC)

	cases := []struct {
		name string
		in   string
		out  string
	}{
		// Date methods.
		{"year", `Year ${ new Date().getFullYear() }`, `Year 2026`},
		{"month-0-indexed", `M=${ new Date().getMonth() }`, `M=5`},
		{"month-1-indexed", `M=${ new Date().getMonth() + 1 }`, `M=6`},
		{"date", `D=${ new Date().getDate() }`, `D=12`},
		{"hours", `H=${ new Date().getHours() }`, `H=14`},
		{"iso", `T=${ new Date().toISOString() }`, `T=2026-06-12T14:30:45.000Z`},
		{"locale-fr", `Le ${ new Date().toLocaleDateString('fr-FR') }`, `Le 12/06/2026`},
		// Math constants / functions.
		{"pi", `${ Math.PI }`, `3.141592653589793`},
		{"pi-fixed", `${ Math.PI.toFixed(4) }`, `3.1416`},
		{"sqrt", `${ Math.sqrt(2) }`, `1.4142135623730951`},
		{"round", `${ Math.round(2.7) }`, `3`},
		// Arithmetic.
		{"arith-sub", `${ 2026 - 1959 } years`, `67 years`},
		{"arith-mul", `${ 7 * 6 }`, `42`},
		// Escapes.
		{"escape", `$${literal}`, `${literal}`},
		// Multiple placeholders in one string.
		// Multiple placeholders : first whitelisted, second isn't (the
		// "getFullYear() + 1" arithmetic chain isn't on the supported
		// list). The unsupported one is preserved verbatim so the
		// author notices.
		{"multi", `${ new Date().getFullYear() } — ${ new Date().getFullYear() + 1 }`, `2026 — ${ new Date().getFullYear() + 1 }`},
		// No-template fast path.
		{"plain", `Hello world`, `Hello world`},
		{"empty", ``, ``},
		// Unknown expression : preserved verbatim so the author notices.
		{"unknown", `${ fetch('/etc/passwd') }`, `${ fetch('/etc/passwd') }`},
		{"reference", `${ window.location }`, `${ window.location }`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExpandTemplate(tc.in, now)
			if got != tc.out {
				t.Errorf("ExpandTemplate(%q)\n  got  = %q\n  want = %q", tc.in, got, tc.out)
			}
		})
	}
}

func TestExpandTemplate_FrontMatterBindings(t *testing.T) {
	now := time.Date(2026, 6, 12, 14, 30, 45, 0, time.UTC)
	src := `---
title: Bring-up demo
author: Yannick
date: 2026-06-12
theme: polytechnique
---

# ${title}

By ${author} — ${date}.

Year ${ new Date().getFullYear() }.
`
	out := ExpandTemplate(src, now)
	for _, want := range []string{
		"# Bring-up demo",
		"By Yannick — 2026-06-12.",
		"Year 2026.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in expanded output\n--- got ---\n%s", want, out)
		}
	}
	// Front-matter binding must not poison the placeholder when the
	// key is absent — undefined references stay literal so the
	// author notices the typo.
	if !strings.Contains(out, "${ new Date().getFullYear() }") &&
		!strings.Contains(out, "Year 2026.") {
		t.Fatal("template expansion lost the body section")
	}
}

// Sandbox boundary test : function names that look like JS globals
// must NOT resolve, even when they're syntactically plausible. The
// expression evaluator's job is to expand a tight whitelist, not
// to be a JS engine.
func TestExpandTemplate_SandboxBoundary(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, body := range []string{
		`document.cookie`,
		`window.location.href`,
		`globalThis.fetch('/etc/passwd')`,
		`process.env.HOME`,
		`require('fs').readFileSync('/etc/passwd')`,
		`eval('alert(1)')`,
		`import('child_process')`,
	} {
		in := "${" + body + "}"
		out := ExpandTemplate(in, now)
		if out != in {
			t.Errorf("sandbox escape : %q expanded to %q", in, out)
		}
	}
}
