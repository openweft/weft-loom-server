package compile

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveLatexEngine covers the engine normalisation rules :
// known values pass through, empty defaults to pdflatex, unknown
// values fall back to pdflatex with a warning event.
func TestResolveLatexEngine(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		warning bool
	}{
		{"", "pdflatex", false},
		{"pdflatex", "pdflatex", false},
		{"lualatex", "lualatex", false},
		{"xelatex", "xelatex", false},
		{"latex-2049", "pdflatex", true},
		{"PDFLATEX", "pdflatex", true}, // case-sensitive
	}
	for _, tc := range cases {
		var warned bool
		emit := func(ev Event) {
			if ev.Kind == "log" && len(ev.Line) > 0 && ev.Line[0] == 'W' {
				warned = true
			}
		}
		got := resolveLatexEngine(tc.in, emit)
		if got != tc.want {
			t.Errorf("resolveLatexEngine(%q) = %q ; want %q", tc.in, got, tc.want)
		}
		if warned != tc.warning {
			t.Errorf("resolveLatexEngine(%q) warned = %v ; want %v", tc.in, warned, tc.warning)
		}
	}
}

func TestResolveBibEngine(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "bibtex"},
		{"bibtex", "bibtex"},
		{"biber", "biber"},
		{"natbib", "bibtex"}, // unknown → fallback
	}
	for _, tc := range cases {
		got := resolveBibEngine(tc.in, func(Event) {})
		if got != tc.want {
			t.Errorf("resolveBibEngine(%q) = %q ; want %q", tc.in, got, tc.want)
		}
	}
}

// TestBibTrigger : the bib pass only fires when the right trigger
// file is present in scratch — .aux+\bibdata for bibtex, .bcf for
// biber. Empty scratch must return "" so we don't spawn a no-op
// bibtex run on every LaTeX compile.
func TestBibTrigger(t *testing.T) {
	dir := t.TempDir()
	base := "main"

	// Empty scratch dir : neither engine should trigger.
	if got := bibTrigger(dir, base, "bibtex"); got != "" {
		t.Errorf("empty scratch bibtex = %q ; want \"\"", got)
	}
	if got := bibTrigger(dir, base, "biber"); got != "" {
		t.Errorf("empty scratch biber = %q ; want \"\"", got)
	}

	// .aux without \bibdata — no trigger.
	auxPath := filepath.Join(dir, base+".aux")
	if err := os.WriteFile(auxPath, []byte("\\relax\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := bibTrigger(dir, base, "bibtex"); got != "" {
		t.Errorf("aux without \\bibdata = %q ; want \"\"", got)
	}

	// .aux WITH \bibdata — triggers bibtex.
	if err := os.WriteFile(auxPath, []byte("\\bibdata{refs}\n\\citation{foo}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := bibTrigger(dir, base, "bibtex"); got != base {
		t.Errorf("aux with \\bibdata = %q ; want %q", got, base)
	}
	// Still no .bcf → biber shouldn't trigger.
	if got := bibTrigger(dir, base, "biber"); got != "" {
		t.Errorf("biber without .bcf = %q ; want \"\"", got)
	}

	// .bcf present — biber triggers.
	bcfPath := filepath.Join(dir, base+".bcf")
	if err := os.WriteFile(bcfPath, []byte("<bcf/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := bibTrigger(dir, base, "biber"); got != base {
		t.Errorf("biber with .bcf = %q ; want %q", got, base)
	}
}

// TestBibCommand : the workspace / microVM dispatch path needs an
// absolute path to the .aux/.bcf base so the binary resolves
// regardless of the CWD chosen by the dispatcher.
func TestBibCommand(t *testing.T) {
	got := bibCommand("biber", "/scratch/abc", "main")
	want := []string{"biber", "/scratch/abc/main"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("bibCommand biber = %v ; want %v", got, want)
	}
	got = bibCommand("bibtex", "/scratch/abc", "main")
	want = []string{"bibtex", "/scratch/abc/main"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("bibCommand bibtex = %v ; want %v", got, want)
	}
}
