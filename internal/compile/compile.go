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

	mu        sync.Mutex
	jobs      map[string]*runningJob
	artifacts map[string]string // jobID → absolute artifact path
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

	// Dispatch to the per-language builder.
	var artifactPath string
	var err error
	switch spec.Language {
	case "latex":
		artifactPath, err = s.compileLatex(workDir, scratchDir, spec, emit)
	case "markdown":
		artifactPath, err = s.compileMarkdown(workDir, scratchDir, spec, emit)
	default:
		err = fmt.Errorf("language %q not supported for in-window PDF compile (use the Run button + manual download for other languages)", spec.Language)
	}

	dur := time.Since(start).Milliseconds()
	if err != nil {
		emit(Event{Kind: "result", Success: false, Message: err.Error(), DurationMs: dur})
		return
	}

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
	// LaTeX needs two passes for cross-references ; the command is
	// run twice in either dispatch path.
	args := []string{
		"-interaction=nonstopmode",
		"-halt-on-error",
		"-output-directory=" + scratchDir,
		entryAbs,
	}
	args = append(args, spec.ExtraArgs...)

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
	isMarp := detectMarp(string(src))
	outPath := filepath.Join(scratchDir, strings.TrimSuffix(filepath.Base(entry), filepath.Ext(entry))+".pdf")

	if isMarp {
		args := []string{"--pdf", "--allow-local-files", "-o", outPath, entryAbs}
		args = append(args, spec.ExtraArgs...)
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
