package server

// api_seed.go — atomic "you are the seeder" election for a
// (project, file) tuple. Replaces the client-side designated-seeder
// race where two browsers opening the same file simultaneously each
// believed they were alone in awareness and both seeded — Yjs CRDT
// then merged the two independent inserts into a duplicated buffer.
//
// Protocol :
//
//   POST /api/projects/{name}/files/{path...}/seed-claim
//     200 → you are the elected seeder ; do the disk read + insert
//     409 → someone else already holds the claim ; wait for the WS
//          sync to deliver the seed
//
// The claim is sticky for the lifetime of the loom-server process.
// A future loom-doctor observability hook would reset claims on
// "room emptied" events ; for now the file changes via the editor
// itself naturally keep the on-disk + in-memory state in sync.

import (
	"net/http"
	"sync"
	"time"

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

func (s *Server) handleSeedClaim(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.identify(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if _, err := s.opts.Projects.ListFiles(r.Context(), ident, projectName(r)); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	key := seedKey(ident, projectName(r), filePath(r))
	if s.seedClaims.claim(key) {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "seed", Verb: "claim.elected",
			Project: projectName(r),
			Fields:  map[string]any{"file": filePath(r), "subject": ident.Subject},
		})
		writeJSON(w, http.StatusOK, map[string]any{"elected": true})
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "seed", Verb: "claim.rejected",
		Project: projectName(r),
		Fields:  map[string]any{"file": filePath(r), "subject": ident.Subject},
	})
	writeJSON(w, http.StatusConflict, map[string]any{"elected": false})
}
