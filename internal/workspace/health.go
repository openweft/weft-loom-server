package workspace

// health.go — small atomic last-heartbeat tracker used by the
// QEMUProvisioner to surface a Health() string from the VM struct.
// Plain time-based state ; no NATS subscription persistence — the
// QEMUProvisioner owns the lifetime of both the subscription + the
// HealthState.

import (
	"sync/atomic"
	"time"
)

type healthState struct {
	lastBeatUnixNano atomic.Int64
}

func newHealthState() *healthState {
	hs := &healthState{}
	hs.lastBeatUnixNano.Store(0)
	return hs
}

func (h *healthState) beat() {
	h.lastBeatUnixNano.Store(time.Now().UnixNano())
}

func (h *healthState) snapshot() string {
	last := h.lastBeatUnixNano.Load()
	if last == 0 {
		return "booting"
	}
	age := time.Duration(time.Now().UnixNano() - last)
	if age > 10*time.Second {
		return "stale"
	}
	return "healthy"
}
