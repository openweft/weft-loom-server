package server

// sidecar_lock.go — per-project mutex pool used to serialise
// read-modify-write blocks on the .weft-loom/*.json sidecars
// (sharing, snippets, public-share, owner pin).
//
// The atomic write at the project.LocalStore layer prevents TORN
// reads ; this pool prevents LOST UPDATES — when two concurrent
// upserts both read state S, modify to S+a and S+b in memory, then
// each writes back. Without the mutex one write wins and the other
// silently drops.
//
// Granularity is per (project, sidecar) string so two unrelated
// projects don't contend. Locks are created lazily + retained for
// the server's lifetime ; the pool can't grow unbounded in practice
// (one entry per active sidecar per project, and projects come from
// authenticated callers).

import "sync"

// sidecarLockPool is the shared registry. Each lock guards the
// read-modify-write critical section for one sidecar of one project.
type sidecarLockPool struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func newSidecarLockPool() *sidecarLockPool {
	return &sidecarLockPool{locks: map[string]*sync.Mutex{}}
}

// lockFor returns the mutex guarding (project, sidecar). Caller MUST
// Lock + Unlock through the returned *sync.Mutex. Repeated calls with
// the same key return the same instance.
func (p *sidecarLockPool) lockFor(project, sidecar string) *sync.Mutex {
	key := project + "/" + sidecar
	p.mu.Lock()
	m, ok := p.locks[key]
	if !ok {
		m = &sync.Mutex{}
		p.locks[key] = m
	}
	p.mu.Unlock()
	return m
}
