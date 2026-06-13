package workspace

// qemu_shutdown.go — graceful shutdown helpers for the QEMU workspace
// VM. Sends `system_powerdown` (ACPI) over the QEMU monitor socket
// + waits up to gracePeriod for the Dead channel to close, then
// SIGKILLs the process as a fallback.
//
// Symmetric across loom-server shutdown (Registry.Close called on
// SIGTERM) + per-VM eviction (future LRU on the workspace pool).

import (
	"context"
	"fmt"
	"net"
	"path/filepath"
	"time"
)

const defaultGracePeriod = 10 * time.Second

// shutdownVM sends ACPI powerdown to the named VM via its monitor
// socket, then waits for the Dead channel to close. Returns nil
// once dead OR after the grace period (caller decides whether to
// SIGKILL).
func shutdownVM(ctx context.Context, dir string, dead <-chan struct{}) error {
	sock := filepath.Join(dir, "qemu-monitor.sock")
	conn, err := net.DialTimeout("unix", sock, 2*time.Second)
	if err != nil {
		// Already gone OR monitor never came up — treat as dead.
		return nil
	}
	defer conn.Close()
	// HMP : "system_powerdown" + newline. QEMU prints a prompt back
	// we don't bother to read ; the close on defer handles cleanup.
	if _, werr := conn.Write([]byte("system_powerdown\n")); werr != nil {
		return fmt.Errorf("write powerdown: %w", werr)
	}
	timer := time.NewTimer(defaultGracePeriod)
	defer timer.Stop()
	select {
	case <-dead:
		return nil
	case <-timer.C:
		return fmt.Errorf("grace period elapsed without dead signal")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close shuts down every live workspace VM in the registry. Called
// by the loom-server's main on SIGTERM. Best-effort : a failed
// graceful shutdown still attempts the next VM.
func (r *Registry) Close(ctx context.Context) {
	r.mu.Lock()
	results := make([]*ensureResult, 0, len(r.vm))
	for _, er := range r.vm {
		results = append(results, er)
	}
	r.mu.Unlock()
	for _, er := range results {
		if er.vm == nil {
			continue
		}
		_ = shutdownVM(ctx, er.vm.WorkDir, er.vm.Dead)
		if er.vm.Close != nil {
			er.vm.Close()
		}
	}
}
