package toolshare

// bundle.go — render the OCI runtime-spec config.json that wraps an
// unpacked rootfs into a `crun exec`-able bundle. The bundle dir
// lives next to the rootfs (`<targetDir>/bundle/config.json`) and is
// pointed at via the .current symlink so tool wrappers in the guest
// don't need to know the digest.

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func writeBundleConfig(targetDir, logicalName string) error {
	bundleDir := filepath.Join(targetDir, "bundle")
	if err := os.MkdirAll(bundleDir, 0o755); err != nil {
		return err
	}
	spec := map[string]any{
		"ociVersion": "1.0.2",
		"process": map[string]any{
			// terminal=false for the warm-keeper entrypoint :
			// `crun run --detach` rejects terminal=true without
			// --console-socket, and we have no use for a tty on
			// the sleep loop ; `crun exec` opens its own tty per
			// wrapper invocation.
			"terminal": false,
			"user":     map[string]any{"uid": 0, "gid": 0},
			// Default argv : sleep-forever so the container stays
			// warm. Tool wrappers `crun exec` against the running
			// container with the real binary + args.
			"args": []string{"/bin/sh", "-c", "while true; do sleep 3600; done"},
			"env": []string{
				"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
				"HOME=/root",
				"TERM=xterm",
				"LANG=C.UTF-8",
			},
			"cwd": "/workspace",
			"capabilities": map[string]any{
				"bounding":  []string{"CAP_AUDIT_WRITE", "CAP_KILL"},
				"effective": []string{"CAP_AUDIT_WRITE", "CAP_KILL"},
				"permitted": []string{"CAP_AUDIT_WRITE", "CAP_KILL"},
			},
			"noNewPrivileges": true,
		},
		// root.path is RELATIVE to the bundle dir : `../rootfs` lands
		// on <targetDir>/rootfs. crun resolves relative paths against
		// the --bundle arg.
		"root": map[string]any{
			"path":     "../rootfs",
			"readonly": true,
		},
		"hostname": logicalName,
		"mounts": []map[string]any{
			{"destination": "/proc", "type": "proc", "source": "proc"},
			{"destination": "/sys", "type": "sysfs", "source": "sysfs",
				"options": []string{"nosuid", "noexec", "nodev", "ro"}},
			{"destination": "/dev", "type": "tmpfs", "source": "tmpfs",
				"options": []string{"nosuid", "strictatime", "mode=755", "size=65536k"}},
			{"destination": "/dev/pts", "type": "devpts", "source": "devpts",
				"options": []string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"}},
			// Pass /workspace from the agent's rootfs (the user's
			// virtio-9p mount) into the container so the tool sees
			// the same project files.
			{"destination": "/workspace", "type": "bind", "source": "/workspace",
				"options": []string{"bind", "rw", "rprivate"}},
		},
		"linux": map[string]any{
			"namespaces": []map[string]any{
				{"type": "pid"},
				{"type": "mount"},
				{"type": "ipc"},
				{"type": "uts"},
			},
		},
	}
	b, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(bundleDir, "config.json"), b, 0o644)
}
