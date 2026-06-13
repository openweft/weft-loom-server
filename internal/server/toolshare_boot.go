package server

// toolshare_boot.go — wire the toolshare.Manager into the loom-server
// boot path. On startup we kick off Ensure() for every tool listed in
// WEFT_LOOM_TOOLS (CSV of logical=ref pairs) so by the time the
// pre-spawned workspace VMs land their first shell click, the
// /opt/tools/ mount already carries the unpacked rootfs + bundle.
//
// Image pulls take minutes for texlive (~2 GiB). Loom-server's
// listen never blocks on them ; the pulls run in background +
// surface progress via the loom-doctor event stream.

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/toolshare"
)

// parseToolsSpec walks WEFT_LOOM_TOOLS like
//
//	texlive=texlive/texlive:latest-basic,markdown=ghcr.io/openweft/weft-loom-markdown:latest
//
// into (logicalName, ref) pairs. Whitespace + empty entries are skipped.
func parseToolsSpec(spec string) [][2]string {
	if spec == "" {
		return nil
	}
	var out [][2]string
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		idx := strings.IndexByte(part, '=')
		if idx <= 0 || idx == len(part)-1 {
			continue
		}
		out = append(out, [2]string{strings.TrimSpace(part[:idx]), strings.TrimSpace(part[idx+1:])})
	}
	return out
}

// ensureTools kicks off the configured tool image pulls in parallel.
// Called from server.New() inside its own goroutine so loom-server's
// HTTP listen comes up immediately.
func (s *Server) ensureTools() {
	if s.toolshare == nil {
		return
	}
	pairs := parseToolsSpec(os.Getenv("WEFT_LOOM_TOOLS"))
	if len(pairs) == 0 {
		return
	}
	for _, p := range pairs {
		go s.ensureOneTool(p[0], p[1])
	}
}

func (s *Server) ensureOneTool(logicalName, ref string) {
	start := time.Now()
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "toolshare", Verb: "ensure.start",
		Fields: map[string]any{"logical": logicalName, "ref": ref},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if err := s.toolshare.Ensure(ctx, logicalName, ref); err != nil {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "toolshare", Verb: "ensure.err",
			Level:  "warn",
			Fields: map[string]any{"logical": logicalName, "ref": ref, "err": err.Error()},
		})
		return
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "toolshare", Verb: "ensure.ready",
		Fields: map[string]any{
			"logical":    logicalName,
			"ref":        ref,
			"elapsed_ms": time.Since(start).Milliseconds(),
		},
	})
}

// toolshareFromEnv reads WEFT_LOOM_TOOLS_PATH and wires a Manager.
// Falls back to ~/.weft-loom/tools/ when unset.
func toolshareFromEnv() *toolshare.Manager {
	return toolshare.New(os.Getenv("WEFT_LOOM_TOOLS_PATH"))
}
