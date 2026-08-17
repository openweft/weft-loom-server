package server

// shutdown.go — orderly teardown for the loom-server process. Main
// calls Shutdown() from its SIGTERM handler ; the order matters :
//
//   1. stop accepting new HTTP via the *http.Server (main does this).
//   2. gracefully powerdown every workspace VM (ACPI via QEMU monitor).
//   3. shutdown the embedded NATS broker last so the VMs' agent
//      have a working bus during their own shutdown sequence.

import (
	"context"
)

// Shutdown tears down the server's owned resources. main is
// responsible for the http.Server shutdown ; Shutdown handles
// the workspace VMs + embedded broker.
func (s *Server) Shutdown(ctx context.Context) {
	// The documents first, and before anything that could take the database
	// away: closing saves everything that changed since the last interval, and
	// a comment written a second ago is exactly what would otherwise be lost.
	if s.collab != nil {
		if err := s.collab.Close(ctx); err != nil {
			s.opts.Logger.Error("collab: saving on shutdown failed", "err", err.Error())
		}
	}
	if s.collabDB != nil {
		// The pool underneath belongs to the project store, which closes it.
		// This only gives back the database/sql wrapper around it.
		_ = s.collabDB.Close()
	}
	if s.workspaces != nil {
		s.workspaces.Close(ctx)
	}
	if s.natsBroker != nil {
		s.natsBroker.Shutdown()
	}
}
