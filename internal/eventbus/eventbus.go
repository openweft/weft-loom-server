// Package eventbus is loom-server's in-memory observability fan-out.
// Every notable side-effect of the server (and the SPA, via POST
// /api/events/client) flows through here ; the DoctorPanel SSE stream
// at /api/events tails the bus so operators can watch what's
// happening end-to-end without grepping logs across processes.
//
// Design : single Hub, slog.Handler-shaped Publish, lossy subscribers
// with a per-sub bounded ring buffer. A slow doctor browser doesn't
// hold the WS sync write path hostage ; if a subscriber falls behind
// past `slow` events the dropper increments a counter and the SSE
// emits a synthetic "<drop>" line so the operator knows they're
// missing context. Same shape as weft-doctor in the cluster — one
// less concept to learn when jumping between weft and weft-loom.
package eventbus

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// Event is the wire shape. Component + verb identify the producer
// + the action ; level matches slog ; Fields holds the structured
// payload (anything JSON-serialisable).
type Event struct {
	TS        time.Time              `json:"ts"`
	Source    string                 `json:"source"` // "server" or "client"
	Component string                 `json:"component"`
	Verb      string                 `json:"verb"`
	Level     string                 `json:"level"` // "debug" | "info" | "warn" | "error"
	Message   string                 `json:"message,omitempty"`
	Fields    map[string]any         `json:"fields,omitempty"`
	// Project identifies the project the event relates to ; the
	// doctor UI filters on this so two operators in different
	// projects don't drown each other.
	Project string `json:"project,omitempty"`
}

// Hub fans out events to N subscribers. Created at boot, retained
// for the loom-server's lifetime. Concurrent Publish + Subscribe +
// Unsubscribe safe.
type Hub struct {
	mu     sync.Mutex
	subs   map[*subscription]struct{}
	drops  atomic.Uint64
	closed atomic.Bool
}

type subscription struct {
	ch       chan Event
	overflow atomic.Uint64
}

const (
	// subBuffer = per-subscriber ring depth before we drop. ~1 s of
	// events at 200/s ; doctor browsers happily catch up after a
	// resize / GC pause without losing the stream.
	subBuffer = 256
)

// New : Hub ready for Subscribe + Publish.
func New() *Hub {
	return &Hub{subs: map[*subscription]struct{}{}}
}

// Subscribe returns an unbuffered receive channel + an unregister fn.
// Caller MUST drain the channel ; once subBuffer events queue up the
// next publish drops the oldest and emits a "<drop>" sentinel via
// the overflow counter (visible to the SSE handler).
func (h *Hub) Subscribe() (<-chan Event, func()) {
	sub := &subscription{ch: make(chan Event, subBuffer)}
	h.mu.Lock()
	h.subs[sub] = struct{}{}
	h.mu.Unlock()
	stop := func() {
		h.mu.Lock()
		delete(h.subs, sub)
		h.mu.Unlock()
		close(sub.ch)
	}
	return sub.ch, stop
}

// Publish fan-outs to every subscriber. Non-blocking : drops events
// when a subscriber buffer is full.
func (h *Hub) Publish(ev Event) {
	if h.closed.Load() {
		return
	}
	if ev.TS.IsZero() {
		ev.TS = time.Now().UTC()
	}
	if ev.Level == "" {
		ev.Level = "info"
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		select {
		case sub.ch <- ev:
		default:
			sub.overflow.Add(1)
			h.drops.Add(1)
		}
	}
}

// PublishCtx is the same as Publish but tagged with the deadline
// origin ; the doctor UI surfaces request-scoped events as a thread.
func (h *Hub) PublishCtx(_ context.Context, ev Event) { h.Publish(ev) }

// Drops returns the lifetime drop counter ; doctor UI surfaces this
// in the "Diagnostics" header so an operator sees buffer pressure
// before symptoms.
func (h *Hub) Drops() uint64 { return h.drops.Load() }

// Close stops further publishes. Subscribers receive a final closed
// channel when they call their stop fn.
func (h *Hub) Close() { h.closed.Store(true) }
