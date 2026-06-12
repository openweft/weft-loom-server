// Package compile orchestrates ephemeral compile jobs. V0.3 wires
// real subprocesses for LaTeX (pdflatex) and Marp markdown (marp-cli)
// — both run on the host running loom-server, mounted on the project's
// working tree. V0.4 will dispatch to a weft-microvm with the
// weft-loom-texlive / weft-loom-marp OCI image instead, but the
// subprocess path stays as the dev-mode fallback when no agent is
// configured.
//
// Each job creates a scratch dir under the project's working tree
// (<workingDir>/.weft-loom/<jobID>/) that holds the artifact + any
// auxiliary files (LaTeX .aux/.log etc.). The HTTP handler at
// /api/projects/{p}/compile/{id}/artifact serves the PDF out of
// that dir.
package compile

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/project"
)

// JobSpec is the request shape POSTed to /api/projects/<n>/compile.
type JobSpec struct {
	Project   string   `json:"-"`
	Language  string   `json:"language"`
	Entry     string   `json:"entry,omitempty"`
	ExtraArgs []string `json:"extra_args,omitempty"`
	// CommandOverride : verbatim shell command that REPLACES the
	// language's default when non-empty. Threaded from the
	// SettingsPanel UI : the user types `make build && ./out` once
	// + persists it as a per-language override, and every Run
	// dispatches that command instead of the built-in one.
	// Empty string preserves the existing behaviour.
	CommandOverride string `json:"command,omitempty"`
	// Identity is populated by Start() from the auth.Identity ; the
	// workspace dispatch path uses it to resolve the per-user VM.
	Identity string `json:"-"`
}

// Event is one streamed line during a compile job.
type Event struct {
	Kind         string `json:"kind"`
	Line         string `json:"line,omitempty"`
	Success      bool   `json:"success,omitempty"`
	Artifact     string `json:"artifact,omitempty"`
	ArtifactMIME string `json:"artifact_mime,omitempty"`
	DurationMs   int64  `json:"duration_ms,omitempty"`
	Message      string `json:"message,omitempty"`
}

// Service starts jobs + serves their event streams + holds the
// artifact paths so the HTTP layer can stream them back.
type Service struct {
	store project.Store
	// Workspaces : when non-nil + the user has a NATS-backed VM,
	// every compile job dispatches via Containers + ExecSession
	// instead of the host subprocess path. Same NATS subjects the
	// shell uses → unified observability + no special treatment
	// for texlive vs go vs pandoc.
	Workspaces WorkspaceResolver

	mu        sync.Mutex
	jobs      map[string]*runningJob
	artifacts map[string]string // jobID → absolute artifact path
}

// WorkspaceResolver is the trimmed-down view of workspace.Registry
// the compile service needs : "give me the user's VM". Kept narrow
// so unit tests stub it with a one-VM map and the compile package
// stays decoupled from internal/workspace's full surface.
type WorkspaceResolver interface {
	Ensure(ctx context.Context, ident WorkspaceIdentity) (*WorkspaceVM, error)
}

// WorkspaceIdentity / WorkspaceVM mirror the workspace package's
// types in a trimmed-down form. Adapter lives in cmd/weft-loom.
type WorkspaceIdentity struct {
	Subject string
}

type WorkspaceVM struct {
	VMID    string
	WorkDir string
	Conn    WorkspaceNATS
	Health  func() string
}

// WorkspaceNATS is the publish/subscribe surface compile needs.
type WorkspaceNATS interface {
	Publish(subject string, data []byte) error
	Subscribe(subject string, cb func(subj string, data []byte)) (WorkspaceUnsub, error)
}

type WorkspaceUnsub interface {
	Unsubscribe() error
}

type runningJob struct {
	events chan Event
	done   chan struct{}
}

func New(store project.Store) *Service {
	return &Service{
		store:     store,
		jobs:      map[string]*runningJob{},
		artifacts: map[string]string{},
	}
}

func (s *Service) Start(_ context.Context, ident auth.Identity, spec JobSpec) (string, error) {
	if spec.Project == "" {
		return "", errors.New("compile: project required")
	}
	if spec.Language == "" {
		return "", errors.New("compile: language required")
	}
	spec.Identity = ident.Subject
	id := newJobID()
	j := &runningJob{
		events: make(chan Event, 64),
		done:   make(chan struct{}),
	}
	s.mu.Lock()
	s.jobs[id] = j
	s.mu.Unlock()

	go s.run(ident, id, spec, j)
	return id, nil
}

func (s *Service) Stream(_ context.Context, id string) (<-chan Event, error) {
	s.mu.Lock()
	j, ok := s.jobs[id]
	s.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("compile: unknown job %q", id)
	}
	return j.events, nil
}

// Artifact returns the absolute path of the artifact produced by
// job id, or empty + false if there isn't one.
func (s *Service) Artifact(id string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.artifacts[id]
	return p, ok
}

// run is the per-job goroutine.
func (s *Service) run(ident auth.Identity, id string, spec JobSpec, j *runningJob) {
	start := time.Now()
	defer func() {
		close(j.events)
		close(j.done)
		go func() {
			time.Sleep(30 * time.Minute) // keep artifact downloadable
			s.mu.Lock()
			delete(s.jobs, id)
			delete(s.artifacts, id)
			s.mu.Unlock()
		}()
	}()

	emit := func(ev Event) {
		select {
		case j.events <- ev:
		default:
		}
	}

	emit(Event{Kind: "log", Line: fmt.Sprintf("compile job %s starting (%s)", id, spec.Language)})
	emit(Event{Kind: "log", Line: fmt.Sprintf("⏱  job.start                0ms")})

	// Locate the project's working tree on disk.
	rooted, ok := s.store.(interface{ Root() string })
	if !ok || rooted.Root() == "" {
		emit(Event{
			Kind: "result", Success: false,
			Message:    "project store doesn't expose a filesystem root (S3-only backend?)",
			DurationMs: time.Since(start).Milliseconds(),
		})
		return
	}
	workDir := filepath.Join(rooted.Root(), sanitiseUser(ident.Subject), sanitiseUser(spec.Project))
	if _, err := os.Stat(workDir); err != nil {
		emit(Event{
			Kind: "result", Success: false,
			Message:    "project working tree not found : " + err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		})
		return
	}

	// Scratch dir for the artifact. Lives inside the working tree so
	// it's traversal-safe (resolves under the same root).
	scratchDir := filepath.Join(workDir, ".weft-loom", id)
	if err := os.MkdirAll(scratchDir, 0o755); err != nil {
		emit(Event{
			Kind: "result", Success: false,
			Message:    "create scratch dir : " + err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		})
		return
	}

	emit(Event{Kind: "log", Line: fmt.Sprintf("⏱  job.scratch.ready    %6dms", time.Since(start).Milliseconds())})

	// Dispatch to the per-language builder.
	var artifactPath string
	var err error
	switch spec.Language {
	case "latex":
		artifactPath, err = s.compileLatex(workDir, scratchDir, spec, emit)
	case "markdown":
		artifactPath, err = s.compileMarkdown(workDir, scratchDir, spec, emit)
	default:
		// Generic execution path : streams stdout to the log, no PDF
		// artefact. The per-language command is resolved by
		// runCommandFor() — Go, Python, Rust, Node, C++ etc. Falls
		// back to the workspace μVM's pkgx wrappers when the
		// language has no OCI image published yet.
		artifactPath, err = s.compileGeneric(workDir, scratchDir, spec, emit)
	}

	dur := time.Since(start).Milliseconds()
	if err != nil {
		emit(Event{Kind: "result", Success: false, Message: err.Error(), DurationMs: dur})
		return
	}

	// Surface the artifact path the artifact endpoint will serve.
	// Helps diagnose why /artifact 404s : if the path is wrong (e.g.
	// missing -output-directory adjustment) the operator sees it
	// right next to the compile log.
	emit(Event{Kind: "log", Line: fmt.Sprintf("artifact registered : %s", artifactPath)})
	s.mu.Lock()
	s.artifacts[id] = artifactPath
	s.mu.Unlock()

	emit(Event{
		Kind:         "result",
		Success:      true,
		Artifact:     fmt.Sprintf("/api/projects/%s/compile/%s/artifact", spec.Project, id),
		ArtifactMIME: "application/pdf",
		DurationMs:   dur,
	})
}

// compileLatex runs pdflatex on the project's main.tex (or spec.Entry)
// into scratchDir. Captures stdout line-by-line into the event channel
// so the user sees the LaTeX log as it streams.
//
// Dispatch path :
//   WEFT_LOOM_BACKEND=microvm → microvm.go (weft-loom-texlive image)
//   otherwise                → host pdflatex subprocess (dev fallback)
func (s *Service) compileLatex(workDir, scratchDir string, spec JobSpec, emit func(Event)) (string, error) {
	entry := spec.Entry
	if entry == "" {
		entry = "main.tex"
	}
	entryAbs := filepath.Join(workDir, entry)
	if _, err := os.Stat(entryAbs); err != nil {
		return "", fmt.Errorf("entry file %s : %w", entry, err)
	}
	// Expand `${expression}` placeholders so pdflatex sees the same
	// substituted source the live preview does. We only shadow into
	// scratchDir when the expansion actually changed something, so
	// the common no-templates path takes zero extra IO.
	if src, rerr := os.ReadFile(entryAbs); rerr == nil {
		if expanded := ExpandTemplate(string(src), time.Now()); expanded != string(src) {
			shadow := filepath.Join(scratchDir, filepath.Base(entry))
			if werr := os.WriteFile(shadow, []byte(expanded), 0o644); werr == nil {
				entryAbs = shadow
			}
		}
	}
	// LaTeX needs two passes for cross-references ; the command is
	// run twice in either dispatch path.
	args := []string{
		"-interaction=nonstopmode",
		"-halt-on-error",
		"-output-directory=" + scratchDir,
		entryAbs,
	}
	args = append(args, spec.ExtraArgs...)

	// V0.4 unified path : when the user has a workspace VM with a
	// NATS conn, dispatch via the Containers + ExecSession pattern
	// instead of the legacy `weft microvm run` CLI. Same wire shape
	// the shell tab uses → unified observability + no special
	// treatment for texlive vs go vs pandoc.
	resolveStart := time.Now()
	vm := s.resolveVMForCompile(spec)
	emit(Event{Kind: "log", Line: fmt.Sprintf("⏱  resolveVMForCompile  %6dms  vm=%v", time.Since(resolveStart).Milliseconds(), vm != nil)})
	if vm != nil {
		cmd := append([]string{"pdflatex"}, args...)
		for pass := 1; pass <= 2; pass++ {
			passStart := time.Now()
			emit(Event{Kind: "log", Line: fmt.Sprintf("--- workspace pass %d ---", pass)})
			out, err := s.compileInWorkspace(context.Background(), vm, workDir, "latex", cmd, emit)
			emit(Event{Kind: "log", Line: fmt.Sprintf("⏱  pass.%d.end           %6dms", pass, time.Since(passStart).Milliseconds())})
			if err != nil {
				return "", err
			}
			if pass == 2 {
				return out, nil
			}
		}
	}
	if useMicroVM() {
		cmd := append([]string{"pdflatex"}, args...)
		// Two passes inside the VM. Could be wrapped in a single
		// shell call but the line-level streaming is cleaner this way.
		for pass := 1; pass <= 2; pass++ {
			emit(Event{Kind: "log", Line: fmt.Sprintf("--- microvm pass %d ---", pass)})
			out, err := s.compileInMicroVM(workDir, scratchDir, spec, false, cmd, emit)
			if err != nil {
				return "", err
			}
			if pass == 2 {
				return out, nil
			}
		}
	}

	// Host subprocess fallback.
	bin, err := exec.LookPath("pdflatex")
	if err != nil {
		return "", fmt.Errorf("pdflatex not installed on the loom host (install TeX Live, or set WEFT_LOOM_BACKEND=microvm with the openweft toolchain)")
	}
	emit(Event{Kind: "log", Line: "pdflatex " + strings.Join(args, " ")})
	var lastErr error
	for pass := 1; pass <= 2; pass++ {
		emit(Event{Kind: "log", Line: fmt.Sprintf("--- pass %d ---", pass)})
		lastErr = runStreaming(bin, args, workDir, emit)
		if lastErr != nil {
			break
		}
	}
	if lastErr != nil {
		return "", fmt.Errorf("pdflatex failed : %w", lastErr)
	}
	base := strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))
	pdf := filepath.Join(scratchDir, base+".pdf")
	if _, err := os.Stat(pdf); err != nil {
		return "", fmt.Errorf("pdflatex finished but no PDF at %s", pdf)
	}
	return pdf, nil
}

// compileMarkdown : detects Marp front-matter ; runs marp-cli for
// slide decks or pandoc for regular markdown. Both produce a PDF in
// scratchDir.
func (s *Service) compileMarkdown(workDir, scratchDir string, spec JobSpec, emit func(Event)) (string, error) {
	entry := spec.Entry
	if entry == "" {
		entry = "main.md"
	}
	entryAbs := filepath.Join(workDir, entry)
	src, err := os.ReadFile(entryAbs)
	if err != nil {
		return "", fmt.Errorf("read %s : %w", entry, err)
	}
	// Expand `${expression}` placeholders before the tool sees the
	// source — keeps marp / pandoc output in sync with the live
	// preview. If the expanded text differs from the on-disk source,
	// write it back into scratchDir under the original filename so
	// marp-cli's --allow-local-files relative paths still resolve.
	if expanded := ExpandTemplate(string(src), time.Now()); expanded != string(src) {
		shadow := filepath.Join(scratchDir, filepath.Base(entry))
		if werr := os.WriteFile(shadow, []byte(expanded), 0o644); werr == nil {
			entryAbs = shadow
		}
	}
	isMarp := detectMarp(string(src))
	outPath := filepath.Join(scratchDir, strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))+".pdf")

	if isMarp {
		args := []string{"--pdf", "--allow-local-files", "-o", outPath, entryAbs}
		args = append(args, spec.ExtraArgs...)
		if vm := s.resolveVMForCompile(spec); vm != nil {
			cmd := append([]string{"marp"}, args...)
			if _, err := s.compileInWorkspace(context.Background(), vm, workDir, "markdown", cmd, emit); err != nil {
				return "", err
			}
			return outPath, nil
		}
		if useMicroVM() {
			cmd := append([]string{"marp"}, args...)
			if _, err := s.compileInMicroVM(workDir, scratchDir, spec, true, cmd, emit); err != nil {
				return "", err
			}
		} else {
			bin, err := exec.LookPath("marp")
			if err != nil {
				return "", fmt.Errorf("marp-cli not installed (install via `npm i -g @marp-team/marp-cli`, or set WEFT_LOOM_BACKEND=microvm)")
			}
			emit(Event{Kind: "log", Line: "marp " + strings.Join(args, " ")})
			if err := runStreaming(bin, args, workDir, emit); err != nil {
				return "", fmt.Errorf("marp failed : %w", err)
			}
		}
	} else {
		args := []string{"-o", outPath, entryAbs}
		args = append(args, spec.ExtraArgs...)
		if vm := s.resolveVMForCompile(spec); vm != nil {
			cmd := append([]string{"pandoc"}, args...)
			if _, err := s.compileInWorkspace(context.Background(), vm, workDir, "markdown", cmd, emit); err != nil {
				return "", err
			}
			return outPath, nil
		}
		if useMicroVM() {
			cmd := append([]string{"pandoc"}, args...)
			if _, err := s.compileInMicroVM(workDir, scratchDir, spec, false, cmd, emit); err != nil {
				return "", err
			}
		} else {
			bin, err := exec.LookPath("pandoc")
			if err != nil {
				return "", fmt.Errorf("pandoc not installed (install via `brew install pandoc`, or set WEFT_LOOM_BACKEND=microvm)")
			}
			emit(Event{Kind: "log", Line: "pandoc " + strings.Join(args, " ")})
			if err := runStreaming(bin, args, workDir, emit); err != nil {
				return "", fmt.Errorf("pandoc failed : %w", err)
			}
		}
	}
	if _, err := os.Stat(outPath); err != nil {
		return "", fmt.Errorf("compile finished but no PDF at %s", outPath)
	}
	return outPath, nil
}

// compileGeneric runs the language-appropriate "compile or run"
// command via the workspace μVM. Output is streamed to the log ;
// no PDF artefact (return empty path). The per-language command is
// resolved by runCommandFor() — Go / Python / Rust / Node / C++ /
// Shell etc.
//
// When the language's OCI image isn't published yet, the workspace-
// agent falls back to the host shell (which now ships pkgx
// wrappers for `python3` `go` `node` `npm`).
func (s *Service) compileGeneric(workDir, _scratchDir string, spec JobSpec, emit func(Event)) (string, error) {
	cmd, ok := runCommandFor(spec)
	if !ok {
		return "", fmt.Errorf("language %q not wired for compile (no run command registered) — open a terminal (Ctrl+`) to invoke the toolchain manually", spec.Language)
	}

	resolveStart := time.Now()
	vm := s.resolveVMForCompile(spec)
	emit(Event{Kind: "log", Line: fmt.Sprintf("⏱  resolveVMForCompile  %6dms  vm=%v", time.Since(resolveStart).Milliseconds(), vm != nil)})
	if vm == nil {
		return "", fmt.Errorf("workspace μVM not available — wait for it to boot then retry")
	}

	emit(Event{Kind: "log", Line: fmt.Sprintf("--- workspace run (%s) ---", spec.Language)})
	emit(Event{Kind: "log", Line: "$ " + strings.Join(cmd, " ")})
	if _, err := s.compileInWorkspace(context.Background(), vm, workDir, spec.Language, cmd, emit); err != nil {
		return "", err
	}
	return "", nil
}

// runCommandFor maps a language to the command line that builds /
// runs the project's entry file. Used by compileGeneric.
//
// Conventions :
//   - Go        : `go run <entry>` (or `go run ./...` when entry empty)
//   - Python    : `python3 <entry>`
//   - Rust      : `cargo run` if Cargo.toml present, else `rustc <entry> && ./<entry>`
//   - Node      : `node <entry>`
//   - C / C++   : `g++ <entry> -o /tmp/a.out && /tmp/a.out`
//   - Shell     : `sh <entry>`
//   - Ruby      : `ruby <entry>`
//   - Perl      : `perl <entry>`
//
// Defaults the entry filename when spec.Entry is empty.
func runCommandFor(spec JobSpec) ([]string, bool) {
	// CommandOverride wins unconditionally — bypasses the per-
	// language defaults so the user's "make build && ./out" or
	// "pkgx +deno deno task" runs verbatim. The override flows
	// through `sh -c` so shell idioms (`&&`, `|`, env vars) work
	// inside the workspace μVM.
	if strings.TrimSpace(spec.CommandOverride) != "" {
		return []string{"sh", "-c", spec.CommandOverride}, true
	}
	entry := spec.Entry
	switch spec.Language {
	case "golang", "go":
		// Two-path : if the project has a go.mod, run `go run ./...`
		// (module mode, picks up all sub-packages). Otherwise the
		// project is a one-off script tree, so `go run` the entry file
		// directly — `./...` would error with "directory prefix .
		// does not contain main module or its selected dependencies"
		// on a module-less project. Wrap in `sh -c` so the detection
		// happens inside the workspace μVM at the project CWD.
		if entry == "" {
			entry = "main.go"
		}
		return []string{"sh", "-c",
			"if [ -f go.mod ]; then go run ./...; else go run " + shellQuote(entry) + "; fi",
		}, true
	case "python":
		if entry == "" {
			entry = "main.py"
		}
		return []string{"python3", entry}, true
	case "rust":
		// Use cargo when Cargo.toml is present in the project root,
		// fall back to rustc for one-off scripts. The wrapper script
		// performs the detection inside the workspace μVM since
		// loom-server doesn't know the project tree's CWD.
		if entry == "" {
			entry = "main.rs"
		}
		return []string{"sh", "-c",
			"if [ -f Cargo.toml ]; then cargo run; " +
				"else rustc " + shellQuote(entry) + " -o /tmp/a.out && /tmp/a.out; fi",
		}, true
	case "node", "javascript", "typescript":
		if entry == "" {
			entry = "index.js"
		}
		return []string{"node", entry}, true
	case "cpp", "c++":
		if entry == "" {
			entry = "main.cpp"
		}
		return []string{"sh", "-c", "g++ " + shellQuote(entry) + " -std=c++20 -o /tmp/a.out && /tmp/a.out"}, true
	case "c":
		if entry == "" {
			entry = "main.c"
		}
		return []string{"sh", "-c", "cc " + shellQuote(entry) + " -o /tmp/a.out && /tmp/a.out"}, true
	case "shell", "bash", "sh":
		if entry == "" {
			entry = "main.sh"
		}
		return []string{"sh", entry}, true
	case "ruby":
		if entry == "" {
			entry = "main.rb"
		}
		return []string{"ruby", entry}, true
	case "perl":
		if entry == "" {
			entry = "main.pl"
		}
		return []string{"perl", entry}, true
	}
	return nil, false
}

// shellQuote single-quotes a string for safe interpolation into the
// `sh -c` payload runCommandFor emits for compile-then-run flows.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// detectMarp returns true if the YAML front-matter contains `marp: true`.
func detectMarp(src string) bool {
	if !strings.HasPrefix(src, "---") {
		return false
	}
	end := strings.Index(src[3:], "\n---")
	if end < 0 {
		return false
	}
	front := src[3 : end+3]
	for _, line := range strings.Split(front, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "marp:") && strings.Contains(strings.ToLower(l), "true") {
			return true
		}
	}
	return false
}

// runStreaming executes cmd with args, streaming every stdout +
// stderr line to emit() until exit. Returns the subprocess error.
func runStreaming(bin string, args []string, dir string, emit func(Event)) error {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	pump := func(r io.Reader) {
		s := bufio.NewScanner(r)
		s.Buffer(make([]byte, 1<<16), 1<<20)
		for s.Scan() {
			emit(Event{Kind: "log", Line: s.Text()})
		}
	}
	go pump(stdout)
	go pump(stderr)
	return cmd.Wait()
}

// sanitiseUser mirrors LocalStore's subject → directory mapping.
func sanitiseUser(s string) string {
	if s == "" {
		return "_"
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '-', c == '_':
			out = append(out, c)
		default:
			out = append(out, '_')
		}
	}
	return strings.Trim(string(out), "_")
}

func newJobID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
