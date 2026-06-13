package server

// devagent_bridge.go — adapter wiring devagent.Agent into the
// workspace.DevAgentSpawner contract. We keep the bridge here (not
// in internal/workspace) so the workspace package stays free of
// the os/exec + creack/pty transitive imports — only loom-server's
// own boot path pulls them in.

import (
	"log/slog"

	"github.com/nats-io/nats.go"

	"github.com/openweft/weft-loom-server/internal/devagent"
)

type devAgentBridge struct {
	logger *slog.Logger
}

func (b *devAgentBridge) Spawn(nc *nats.Conn, vmID, workDir string) error {
	_, err := devagent.Start(nc, vmID, workDir, b.logger)
	return err
}
