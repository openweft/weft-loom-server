package server

// workspace_adapter.go — bridge between internal/workspace's full
// types and the trimmed-down WorkspaceResolver interface
// internal/compile depends on. We keep the bridge here so neither
// package transitively imports the other's full surface — same
// pattern as devagent_bridge.go.

import (
	"context"

	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/workspace"
)

type compileWorkspaceAdapter struct {
	reg *workspace.Registry
}

func (a *compileWorkspaceAdapter) Ensure(ctx context.Context, ident compile.WorkspaceIdentity) (*compile.WorkspaceVM, error) {
	vm, err := a.reg.Ensure(ctx, workspace.Identity{Subject: ident.Subject})
	if err != nil {
		return nil, err
	}
	if vm == nil {
		return nil, nil
	}
	return &compile.WorkspaceVM{
		VMID:    vm.VMID,
		WorkDir: vm.WorkDir,
		Conn:    &compileNATSAdapter{conn: vm.Conn},
		Health:  vm.Health,
	}, nil
}

// compileNATSAdapter wraps the workspace.NATSPubSub interface in the
// compile package's narrow interface — same surface, no shared type.
type compileNATSAdapter struct {
	conn workspace.NATSPubSub
}

func (a *compileNATSAdapter) Publish(subject string, data []byte) error {
	if a.conn == nil {
		return nil
	}
	return a.conn.Publish(subject, data)
}

func (a *compileNATSAdapter) Subscribe(subject string, cb func(subj string, data []byte)) (compile.WorkspaceUnsub, error) {
	if a.conn == nil {
		return nil, nil
	}
	unsub, err := a.conn.Subscribe(subject, cb)
	if err != nil {
		return nil, err
	}
	return unsub, nil
}
