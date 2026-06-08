// Package compile orchestrates ephemeral microVM compile jobs. The
// V0.1 backend SIMULATES a compile (returns a canned PDF when
// language=latex, an empty binary otherwise) so the rest of the
// stack is testable end-to-end without a running weft-agent. V0.2
// wires the gRPC client to weft-agent that spawns a real microVM
// from a per-language OCI image (weft-loom-texlive, weft-loom-golang,
// …) with the project files mounted RO + a writable scratch overlay
// for build artefacts.
//
// JobSpec → Service.Start → background goroutine → Event channel
// → SSE stream to the frontend → final "result" event with the
// artifact path or compile error.
package compile

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/project"
)

// JobSpec is the request shape POSTed to /api/projects/<n>/compile.
type JobSpec struct {
	// Project is the project name (filled by the handler from the
	// path param ; clients don't need to populate).
	Project string `json:"-"`
	// Language picks the OCI image weft-agent pulls
	// (latex/go/cpp/python/...). When empty the service detects from
	// the project's language hint.
	Language string `json:"language"`
	// Entry is the main file (e.g. "main.tex", "main.go"). Optional ;
	// per-language defaults apply.
	Entry string `json:"entry,omitempty"`
	// ExtraArgs are appended to the language's default build command.
	ExtraArgs []string `json:"extra_args,omitempty"`
}

// Event is one streamed line during a compile job.
type Event struct {
	Kind string `json:"kind"` // "log" | "result" | "error"
	Line string `json:"line,omitempty"`
	// For Kind=="result" :
	Success     bool   `json:"success,omitempty"`
	Artifact    string `json:"artifact,omitempty"`     // URL the SPA fetches to download
	ArtifactMIME string `json:"artifact_mime,omitempty"`
	DurationMs  int64  `json:"duration_ms,omitempty"`
}

// Service starts jobs + serves their event streams.
type Service struct {
	store project.Store

	mu   sync.Mutex
	jobs map[string]*runningJob
}

type runningJob struct {
	events chan Event
	done   chan struct{}
}

// New builds the service.
func New(store project.Store) *Service {
	return &Service{
		store: store,
		jobs:  map[string]*runningJob{},
	}
}

// Start schedules a compile and returns the job ID immediately.
// The actual compile runs on a background goroutine ; Stream(id)
// taps into its event channel.
func (s *Service) Start(_ context.Context, ident auth.Identity, spec JobSpec) (string, error) {
	if spec.Project == "" {
		return "", errors.New("compile: project required")
	}
	if spec.Language == "" {
		// V0.1 needs an explicit language ; V0.2 will detect from
		// project metadata.
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

// Stream returns the event channel for an in-flight or just-finished
// job. The caller ranges over it ; the channel closes when the job
// emits its terminal event. After close the job's state is reaped.
func (s *Service) Stream(_ context.Context, id string) (<-chan Event, error) {
	s.mu.Lock()
	j, ok := s.jobs[id]
	s.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("compile: unknown job %q", id)
	}
	return j.events, nil
}

// run is the per-job goroutine. V0.1 just emits a heartbeat then a
// canned result so the SPA loop can be developed against this stub.
// V0.2 replaces the body with a gRPC stream to weft-agent that
// proxies the microVM's stdout/stderr and surfaces the artifact
// URL on completion.
func (s *Service) run(_ auth.Identity, id string, spec JobSpec, j *runningJob) {
	start := time.Now()
	defer func() {
		close(j.events)
		close(j.done)
		// Reap after a short grace so a slow consumer can still
		// drain the buffered events.
		go func() {
			time.Sleep(30 * time.Second)
			s.mu.Lock()
			delete(s.jobs, id)
			s.mu.Unlock()
		}()
	}()

	emit := func(ev Event) {
		select {
		case j.events <- ev:
		default:
			// Slow consumer — drop. Their reconnect will re-fetch
			// the artifact via the result endpoint (V0.2).
		}
	}

	emit(Event{Kind: "log", Line: fmt.Sprintf("compile job %s starting", id)})
	emit(Event{Kind: "log", Line: fmt.Sprintf("language=%s entry=%s", spec.Language, spec.Entry)})

	// Simulated work — V0.2 replaces this with the real microVM
	// dispatch.
	time.Sleep(200 * time.Millisecond)
	emit(Event{Kind: "log", Line: "TODO: spawn microVM via weft-agent (V0.2)"})

	emit(Event{
		Kind:         "result",
		Success:      true,
		Artifact:     fmt.Sprintf("/api/projects/%s/compile/%s/artifact", spec.Project, id),
		ArtifactMIME: artifactMIME(spec.Language),
		DurationMs:   time.Since(start).Milliseconds(),
	})
}

func artifactMIME(lang string) string {
	switch lang {
	case "latex":
		return "application/pdf"
	case "go", "cpp", "c":
		return "application/octet-stream"
	default:
		return "application/octet-stream"
	}
}

// newJobID returns a 16-hex-char identifier from crypto/rand.
func newJobID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
