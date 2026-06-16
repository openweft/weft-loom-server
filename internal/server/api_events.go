package server

// api_events.go — the loom-doctor observability surface :
//
//   GET  /api/events           SSE stream of Event records (raw, SSE doesn't fit huma)
//   POST /api/events/client    accept SPA-side events to fan into the same stream (typed huma)
//
// The bus is auth-gated like the rest of /api/* ; in dev mode every
// request is "dev-user" so opening the doctor tab Just Works.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
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

	ch, drops, stop := s.events.SubscribeWithDrops()
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
		case marker, ok := <-drops:
			if !ok {
				return
			}
			n, _ := marker.Fields["drops"].(uint64)
			_, _ = fmt.Fprintf(w, "event: drop\ndata: {\"drops\": %d}\n\n", n)
			flusher.Flush()
		}
	}
}

// clientEventInput is the typed huma wire shape for SPA-side events.
// The body fields mirror the legacy raw JSON shape verbatim so the
// SPA's logbus client doesn't need to change.
type clientEventInput struct {
	Body struct {
		Component string         `json:"component" doc:"Event component (e.g. \"editor\", \"compile\")."`
		Verb      string         `json:"verb" doc:"Event verb (e.g. \"opened\", \"saved\")."`
		Level     string         `json:"level,omitempty" doc:"Severity hint : info | warn | error. Empty = info."`
		Message   string         `json:"message,omitempty" doc:"Free-form message body."`
		Fields    map[string]any `json:"fields,omitempty" doc:"Arbitrary structured fields ; merged with the bus event payload."`
		Project   string         `json:"project,omitempty" doc:"Project name when the event scopes to one."`
	}
}

// clientEventOutput renders 204 No Content on success — no body.
type clientEventOutput struct {
	Status int
}

func mountEventsAPI(api huma.API, s *Server) {
	huma.Register(api, huma.Operation{
		OperationID:   "client-event",
		Method:        "POST",
		Path:          "/api/events/client",
		Summary:       "Publish an SPA-side event to the doctor bus",
		Description:   "Accepts a JSON event from the SPA's logbus client and republishes it onto the in-process event bus, which the SSE stream at GET /api/events fans out to subscribers. The SSE GET endpoint stays raw (streaming doesn't fit huma's typed model).",
		Tags:          []string{"events"},
		DefaultStatus: 204,
	}, func(ctx context.Context, in *clientEventInput) (*clientEventOutput, error) {
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		if _, ok := auth.IdentityFrom(ctx); !ok {
			return nil, huma.Error401Unauthorized("unauthorized")
		}
		if in.Body.Component == "" || in.Body.Verb == "" {
			return nil, huma.Error400BadRequest("component + verb required")
		}
		s.events.Publish(eventbus.Event{
			Source:    "client",
			Component: in.Body.Component,
			Verb:      in.Body.Verb,
			Level:     in.Body.Level,
			Message:   in.Body.Message,
			Fields:    in.Body.Fields,
			Project:   in.Body.Project,
		})
		return &clientEventOutput{Status: 204}, nil
	})
}
