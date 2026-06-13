package shares

// standard.go — the two canonical shares every workspace μVM mounts :
//
//   /workspace  R/W multi-attach  (SPA editor writes via loom-server,
//                                  shell writes from the guest)
//   /opt/tools  R/O multi-attach  (toolshare images shared across all
//                                  user VMs simultaneously)
//
// Each share carries a deterministic ID derived from the (vmID, role)
// so re-publishing is idempotent + teardown finds them by name.

import (
	"github.com/openweft/weft-microvm-init/pkg/pod"
)

// WorkspaceConfig describes what the publisher needs to assemble the
// /workspace mount payload. In dev (virtio-9p) only HostPath is used ;
// in prod (CubeFS) the CubeFS fields drive cfs-client.
type WorkspaceConfig struct {
	HostPath string
	CubeFS   *CubeFSConfig
}

// ToolsConfig is the same shape for the /opt/tools share. R/O multi-
// attach across every user VM, so CubeFS is the prod backend.
type ToolsConfig struct {
	HostPath string
	CubeFS   *CubeFSConfig
}

// CubeFSConfig captures the connection bits without re-declaring the
// pod.CubeFSMount struct (we don't want server packages depending on
// pod for transport ; this stays a value type).
type CubeFSConfig struct {
	Volume    string
	Masters   []string
	Owner     string
	AccessKey string
	SecretKey string
	SubDir    string
}

// WorkspaceMount returns the pod.ShareMount for the user's /workspace
// share, OR (false, _) when no prod backend is configured. In dev
// the init script already mounted /workspace via 9p ; we'd publish
// an envelope only for observability but pod.ShareMount.Validate
// rejects non-CubeFS backends, so we skip publish entirely until
// CubeFS lands.
func WorkspaceMount(vmID string, cfg WorkspaceConfig) (pod.ShareMount, bool) {
	if cfg.CubeFS == nil {
		return pod.ShareMount{}, false
	}
	return pod.ShareMount{
		ID:         "workspace-" + vmID,
		Backend:    BackendCubeFS,
		MountPoint: "/workspace",
		Readonly:   false,
		CubeFS:     toCubeFS(cfg.CubeFS),
	}, true
}

// ToolsMount returns the /opt/tools share R/O. Same dev-skip story
// as WorkspaceMount until CubeFS is wired.
func ToolsMount(vmID string, cfg ToolsConfig) (pod.ShareMount, bool) {
	if cfg.CubeFS == nil {
		return pod.ShareMount{}, false
	}
	return pod.ShareMount{
		ID:         "tools-" + vmID,
		Backend:    BackendCubeFS,
		MountPoint: "/opt/tools",
		Readonly:   true,
		CubeFS:     toCubeFS(cfg.CubeFS),
	}, true
}

func toCubeFS(c *CubeFSConfig) *pod.CubeFSMount {
	if c == nil {
		return nil
	}
	return &pod.CubeFSMount{
		Volume:    c.Volume,
		Masters:   append([]string{}, c.Masters...),
		Owner:     c.Owner,
		AccessKey: c.AccessKey,
		SecretKey: c.SecretKey,
		SubDir:    c.SubDir,
	}
}
