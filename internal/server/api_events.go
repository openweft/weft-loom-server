package server

// api_events.go — the loom-doctor observability surface :
//
//   GET  /api/events           SSE stream of Event records
//   POST /api/events/client    accept SPA-side events to fan into the same stream
//
// The bus is auth-gated like the rest of /api/* ; in dev mode every
// request is "dev-user" so opening the doctor tab Just Works.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/openweft/weft-loom-server/internal/eventbus"
)

func (s *Server) handleEventsStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ch, stop := s.events.Subscribe()
	defer stop()

	// Welcome event so the doctor UI knows the stream is live even
	// before anything else publishes.
	s.events.Publish(eventbus.Event{
		Source:    "server",
		Component: "events",
		Verb:      "subscribed",
		Message:   "doctor stream attached",
		Fields:    map[string]any{"path": r.URL.Path},
	})

	enc := json.NewEncoder(w)
	flushHeartbeat := time.NewTicker(15 * time.Second)
	defer flushHeartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-flushHeartbeat.C:
			// SSE comment line — keeps connection alive across
			// proxies that close idle streams. Doctor ignores it.
			_, _ = fmt.Fprintf(w, ": heartbeat %d\n\n", time.Now().Unix())
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			_, _ = fmt.Fprint(w, "data: ")
			_ = enc.Encode(ev) // newline included by Encode
			_, _ = fmt.Fprint(w, "\n")
			flusher.Flush()
		}
	}
}

type clientEventInput struct {
	Component string                 `json:"component"`
	Verb      string                 `json:"verb"`
	Level     string                 `json:"level,omitempty"`
	Message   string                 `json:"message,omitempty"`
	Fields    map[string]any         `json:"fields,omitempty"`
	Project   string                 `json:"project,omitempty"`
}

func (s *Server) handleClientEvent(w http.ResponseWriter, r *http.Request) {
	var in clientEventInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad event payload", http.StatusBadRequest)
		return
	}
	if in.Component == "" || in.Verb == "" {
		http.Error(w, "component + verb required", http.StatusBadRequest)
		return
	}
	s.events.Publish(eventbus.Event{
		Source:    "client",
		Component: in.Component,
		Verb:      in.Verb,
		Level:     in.Level,
		Message:   in.Message,
		Fields:    in.Fields,
		Project:   in.Project,
	})
	w.WriteHeader(http.StatusNoContent)
}
