package server

// api_seed.go — atomic "you are the seeder" election for a
// (project, file) tuple. Replaces the client-side designated-seeder
// race where two browsers opening the same file simultaneously each
// believed they were alone in awareness and both seeded — Yjs CRDT
// then merged the two independent inserts into a duplicated buffer.
//
// Protocol :
//
//   POST /api/projects/{name}/seed-claim/{path...}
//     200 → you are the elected seeder ; do the disk read + insert
//     409 → someone else already holds the claim ; wait for the WS
//          sync to deliver the seed
//
// The claim is sticky for the lifetime of the loom-server process.
// A future loom-doctor observability hook would reset claims on
// "room emptied" events ; for now the file changes via the editor
// itself naturally keep the on-disk + in-memory state in sync.

import (
	"context"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

// staleClaimAfter — how long a claim sticks before any new caller
// can override it. The original 30 s was too long for the
// page-reload UX : after Cmd+R the user's previous claim was still
// in the registry, the new tab's claim 409'd, + the seed-from-disk
// path waited 3 s before force-fetching = ~3 s of empty editor.
//
// 3 s is plenty to prevent the only race the claim protects
// against : two BROWSERS opening the same file within the same
// awareness-sync window + each believing it's alone + both
// inserting from disk. Awareness propagation is sub-second on the
// local relay ; a 3 s window covers the worst latency scenario
// while letting a reload re-claim almost immediately.
const staleClaimAfter = 3 * time.Second

// seedClaimRegistry is the loom-server-wide map of per-(user,
// project, file) claims. The value is the moment the claim was
// taken ; entries older than staleClaimAfter are auto-evicted on
// the next claim() so a dead seeder doesn't poison the (user, file)
// slot for the rest of the process.
type seedClaimRegistry struct {
	mu     sync.Mutex
	claims map[string]time.Time
}

func newSeedClaimRegistry() *seedClaimRegistry {
	return &seedClaimRegistry{claims: map[string]time.Time{}}
}

func seedKey(ident auth.Identity, project, file string) string {
	return ident.Subject + "\x00" + project + "\x00" + file
}

// claim attempts to register the current client as the seeder for
// the (project, file) tuple. Returns true on first success ; a
// subsequent call within staleClaimAfter returns false. After the
// stale window the slot is reusable so a crashed-mid-seed client
// doesn't permanently block re-opens.
func (r *seedClaimRegistry) claim(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.claims[key]; ok && time.Since(t) < staleClaimAfter {
		return false
	}
	r.claims[key] = time.Now()
	return true
}

// release clears a claim — used by the FileExplorer's "delete file"
// path so a re-create of the same file by another client picks up
// the disk content fresh. Idempotent.
func (r *seedClaimRegistry) release(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.claims, key)
}

// seedClaimInput captures the (project, file) tuple. The file path is
// the stdlib mux `{path...}` suffix wildcard — huma's adapter calls
// r.PathValue("path"), which returns the whole suffix, so the wildcard
// in Operation.Path stays intact at registration time. The OpenAPI
// path template carries the literal `{path...}` placeholder ; clients
// that just substitute via `path-to-regexp`-style helpers still work.
type seedClaimInput struct {
	Project string `path:"name" doc:"Project name"`
	File    string `path:"path" doc:"File path relative to the project root ; matches the {path...} suffix wildcard."`
}

// seedClaimOutput carries the explicit 200/409 split via the Status
// field. The wire body matches the legacy raw handler byte-for-byte :
// { "elected": true } on 200, { "elected": false } on 409.
type seedClaimOutput struct {
	Status int
	Body   struct {
		Elected bool `json:"elected" doc:"True when the caller is the elected seeder ; false when another caller already holds the claim."`
	}
}

func mountSeedAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID: "seed-claim",
		Method:      "POST",
		Path:        "/api/projects/{name}/seed-claim/{path...}",
		Summary:     "Atomic seeder election for one (project, file)",
		Description: "Returns 200 + {elected:true} on the FIRST caller within the staleness window ; 409 + {elected:false} for everyone else. Used by the SPA to break the two-browsers-open-the-same-file race the client-side lowest-clientID heuristic couldn't catch reliably.",
		Tags:        []string{"sync"},
	}, func(ctx context.Context, in *seedClaimInput) (*seedClaimOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, ok := auth.IdentityFrom(ctx)
		if !ok {
			return nil, huma.Error401Unauthorized("unauthorized")
		}
		if _, err := s.opts.Projects.ListFiles(ctx, ident, in.Project); err != nil {
			return nil, huma.Error403Forbidden("forbidden")
		}
		key := seedKey(ident, in.Project, in.File)
		out := &seedClaimOutput{}
		if s.seedClaims.claim(key) {
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "seed", Verb: "claim.elected",
				Project: in.Project,
				Fields:  map[string]any{"file": in.File, "subject": ident.Subject},
			})
			out.Status = 200
			out.Body.Elected = true
			return out, nil
		}
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "seed", Verb: "claim.rejected",
			Project: in.Project,
			Fields:  map[string]any{"file": in.File, "subject": ident.Subject},
		})
		out.Status = 409
		out.Body.Elected = false
		return out, nil
	})
}
