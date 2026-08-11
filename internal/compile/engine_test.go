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
		{"gotex", "gotex", false}, // pure-Go engine
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

// TestLatexCommand : gotex gets its own single-pass CLI (absolute /gotex in a
// container, bare gotex on the host), every other engine the pdflatex flag set.
func TestLatexCommand(t *testing.T) {
	// gotex, containerised → absolute binary + -outdir.
	got := latexCommand("gotex", "/w/main.tex", "/w/.build", nil, true)
	want := []string{"/gotex", "-pdf", "-outdir=/w/.build", "/w/main.tex"}
	if !equalArgs(got, want) {
		t.Errorf("gotex container cmd = %v ; want %v", got, want)
	}
	// gotex, host → bare binary on PATH.
	if got := latexCommand("gotex", "/w/main.tex", "/w/.build", nil, false); got[0] != "gotex" {
		t.Errorf("gotex host binary = %q ; want gotex", got[0])
	}
	// extra args are appended.
	got = latexCommand("gotex", "/w/main.tex", "/w/.build", []string{"-size=12"}, true)
	if got[len(got)-1] != "-size=12" {
		t.Errorf("extra arg not appended : %v", got)
	}
	// pdflatex keeps the TeX Live flags + output-directory.
	got = latexCommand("pdflatex", "/w/main.tex", "/w/.build", nil, true)
	if got[0] != "pdflatex" || !containsArg(got, "-output-directory=/w/.build") || !containsArg(got, "-synctex=1") {
		t.Errorf("pdflatex cmd missing expected flags : %v", got)
	}
}

// TestImageForLanguage : the latex language resolves to the gotex image only
// when engine=="gotex" ; everything else stays on TeX Live. Markdown ignores
// the engine entirely.
func TestImageForLanguage(t *testing.T) {
	if img := imageForLanguage("latex", "gotex", false); img != "ghcr.io/openweft/weft-loom-gotex:latest" {
		t.Errorf("latex+gotex image = %q ; want weft-loom-gotex", img)
	}
	if img := imageForLanguage("latex", "pdflatex", false); img != "ghcr.io/openweft/weft-loom-texlive:latest" {
		t.Errorf("latex+pdflatex image = %q ; want weft-loom-texlive", img)
	}
	if img := imageForLanguage("latex", "", false); img != "ghcr.io/openweft/weft-loom-texlive:latest" {
		t.Errorf("latex+default image = %q ; want weft-loom-texlive", img)
	}
	if img := imageForLanguage("markdown", "gotex", false); img != "ghcr.io/openweft/weft-loom-markdown:latest" {
		t.Errorf("markdown image = %q ; want weft-loom-markdown (engine ignored)", img)
	}
}

// TestContainerNameForLanguage : gotex uses a distinct warm container.
func TestContainerNameForLanguage(t *testing.T) {
	if n := containerNameForLanguage("latex", "gotex"); n != "gotex" {
		t.Errorf("latex+gotex container = %q ; want gotex", n)
	}
	if n := containerNameForLanguage("latex", "pdflatex"); n != "texlive" {
		t.Errorf("latex+pdflatex container = %q ; want texlive", n)
	}
}

// TestPickOutputDirGotex : the artifact locator honours gotex's -outdir flag.
func TestPickOutputDirGotex(t *testing.T) {
	cmd := []string{"/gotex", "-pdf", "-outdir=/w/.build", "/w/main.tex"}
	if d := pickOutputDir(cmd, "/w"); d != "/w/.build" {
		t.Errorf("pickOutputDir(-outdir) = %q ; want /w/.build", d)
	}
	cmd = []string{"pdflatex", "-output-directory=/w/.build", "/w/main.tex"}
	if d := pickOutputDir(cmd, "/w"); d != "/w/.build" {
		t.Errorf("pickOutputDir(-output-directory) = %q ; want /w/.build", d)
	}
}

func equalArgs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
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
