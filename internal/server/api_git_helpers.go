package server

// api_git_helpers.go — tiny shared utilities for the git surface.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// sanitiseFor mirrors LocalStore's path-sanitiser. We can't import
// it without a circular dep (project package → server) so we
// re-implement here. Identical semantics : keep alphanumerics +
// dash + underscore, replace everything else with '_'.
func sanitiseFor(s string) string {
	if s == "" {
		return "_"
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '-', c == '_':
			out = append(out, c)
		default:
			out = append(out, '_')
		}
	}
	return strings.Trim(string(out), "_")
}

func writeConfigSidecar(projectDir string, cfg gitConfig) error {
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(projectDir, ".git-config.json"), b, 0o600)
}

// projectStorageRoot exposes the configured project store root path
// to the api_git handlers. Returns "" when the underlying store
// doesn't expose a filesystem root (e.g. a future S3-only backend).
func (s *Server) projectStorageRoot() string {
	if v, ok := s.opts.Projects.(interface{ Root() string }); ok {
		return v.Root()
	}
	return ""
}
