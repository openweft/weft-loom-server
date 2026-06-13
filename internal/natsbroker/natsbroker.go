// Package natsbroker is the embedded NATS server loom-server boots
// when WEFT_NATS_URL isn't externally provided. Single-binary dev
// experience : the operator never sees a separate broker process,
// the agent inside the workspace VM dials back into the loom-server
// host on a loopback port (in dev mode the agent itself is also
// in-process — see internal/devagent).
//
// JetStream is enabled because the containers + mounts reconcilers
// rely on it (LastPerSubject replay). Storage lives under the same
// XDG dir the rest of weft-loom uses so a single rm wipes everything.
package natsbroker

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/nats-io/nats-server/v2/server"
)

// Options bundles the embed knobs. Defaults are picked so a fresh
// dev box "just works" : random port if unused, JetStream on,
// store path under the operator's XDG cache.
type Options struct {
	// Host the broker listens on. "127.0.0.1" is the safe default —
	// the VM reaches in via a host loopback alias the QEMU launcher
	// configures (`-netdev user,id=net0,hostfwd=...`).
	Host string
	// Port. 0 = let the OS pick.
	Port int
	// StoreDir is where JetStream persists streams (weft-mounts,
	// weft-containers). Created with 0o700.
	StoreDir string
}

// Embedded is the running broker. URL is what callers should pass
// to nats.Connect — typically the LocalProvisioner reads it from
// here when WEFT_NATS_URL is empty.
type Embedded struct {
	srv *server.Server
	URL string
}

// Start spins up the broker. Returns when JetStream is ready to
// accept publishes — typically <300 ms.
func Start(opts Options) (*Embedded, error) {
	if opts.Host == "" {
		opts.Host = "127.0.0.1"
	}
	if opts.StoreDir == "" {
		opts.StoreDir = filepath.Join("/tmp", "weft-loom-nats")
	}
	srvOpts := &server.Options{
		Host:                   opts.Host,
		Port:                   opts.Port,
		ServerName:             "weft-loom-embedded",
		JetStream:              true,
		StoreDir:               opts.StoreDir,
		DisableShortFirstPing:  true,
		NoSigs:                 true, // we own signal handling
	}
	srv, err := server.NewServer(srvOpts)
	if err != nil {
		return nil, fmt.Errorf("embed nats: %w", err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(5 * time.Second) {
		srv.Shutdown()
		return nil, fmt.Errorf("embed nats: not ready within 5s")
	}
	return &Embedded{srv: srv, URL: srv.ClientURL()}, nil
}

// Shutdown stops the broker + drains JetStream. Idempotent.
func (e *Embedded) Shutdown() {
	if e.srv != nil {
		e.srv.Shutdown()
		e.srv.WaitForShutdown()
	}
}
