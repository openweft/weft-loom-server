// Command weft-loom is the Sovereign Collaborative Edition server. It hosts
// CodeMirror+Yjs-powered project editing (LaTeX, Markdown, Go, C++,
// Python, anything CodeMirror has a lang pack for) and dispatches
// compile jobs to ephemeral microVMs via weft-agent.
//
// Subcommands :
//
//	weft-loom serve    — long-lived HTTP/WS server
//	weft-loom version  — build info
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	weftslognats "github.com/openweft/weft-slognats"

	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/config"
	"github.com/openweft/weft-loom-server/internal/project"
	"github.com/openweft/weft-loom-server/internal/server"
	"github.com/openweft/weft-loom-server/internal/web"
)

// Build metadata, injected via -ldflags.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	if err := rootCmd().Execute(); err != nil {
		os.Exit(1)
	}
}

func rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:          "weft-loom",
		Short:        "Sovereign Collaborative Edition + sandboxed compile for openweft",
		Long:         "weft-loom is the Sovereign Collaborative Edition service : CodeMirror + Yjs in the browser, gRPC-orchestrated microVM compilers on the server side. One server, any language CodeMirror has a lang pack for.",
		SilenceUsage: true,
	}
	root.AddCommand(versionCmd(), serveCmd())
	return root
}

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print version information",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, err := fmt.Fprintf(cmd.OutOrStdout(), "weft-loom %s (commit %s, built %s)\n", version, commit, date)
			return err
		},
	}
}

func serveCmd() *cobra.Command {
	var configPath string
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run the HTTP / WebSocket server",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(configPath)
			if err != nil {
				return fmt.Errorf("config: %w", err)
			}
			return serve(cmd.Context(), cfg)
		},
	}
	cmd.Flags().StringVar(&configPath, "config", "/etc/weft-loom/config.hcl", "HCL configuration file")
	return cmd
}

func serve(ctx context.Context, cfg config.Config) error {
	log, logCloser := weftslognats.SetupFromEnv("weft.loom." + hostname() + ".log")
	defer logCloser.Close()
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(cfg.StorageRoot, 0o755); err != nil {
		return fmt.Errorf("storage_root mkdir: %w", err)
	}
	// Factory : PostgresStore for HA clusters (metadata in weft-ha-
	// postgresql, file content on a shared weft-block volume mounted
	// at StorageRoot), LocalStore for dev (everything on local FS).
	var store project.Store
	if cfg.PostgresDSN != "" {
		pgStore, err := project.NewPostgresStore(ctx, cfg.PostgresDSN, cfg.StorageRoot)
		if err != nil {
			return fmt.Errorf("postgres store: %w", err)
		}
		defer pgStore.Close()
		store = pgStore
		log.Info("project store : postgres", "files_root", cfg.StorageRoot)
	} else {
		store = project.NewLocalStore(cfg.StorageRoot)
		log.Info("project store : local fs", "root", cfg.StorageRoot)
	}
	compiler := compile.New(store)

	// SPA bundle is held by the internal/web package — keeping the
	// //go:embed there avoids the cmd/ -> sibling-dir embed limitation.
	spa, err := web.DistFS()
	if err != nil {
		log.Warn("spa bundle missing — frontend will 404", "err", err)
		spa = nil
	}

	srv, err := server.New(server.Options{
		Logger:   log,
		Static:   spa,
		Projects: store,
		Compiler: compiler,
		// Auth nil = dev mode for V0.1 ; V0.2 wires dex.
	})
	if err != nil {
		return fmt.Errorf("server: %w", err)
	}

	httpSrv := &http.Server{
		Addr:    cfg.Listen,
		Handler: srv,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("weft-loom listening", "addr", cfg.Listen, "storage_root", cfg.StorageRoot)
		errCh <- httpSrv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal", "reason", ctx.Err())
		shutCtx, cancel := context.WithTimeout(context.Background(), 15e9) // 15 s : workspace VMs need ~10 s ACPI grace
		defer cancel()
		// Stop accepting new HTTP first, then powerdown workspace
		// VMs gracefully, then close the embedded broker.
		httpErr := httpSrv.Shutdown(shutCtx)
		srv.Shutdown(shutCtx)
		return httpErr
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
		return nil
	}
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}
