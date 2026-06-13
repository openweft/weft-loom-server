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
	if err := os.WriteFile(filepath.Join(projectDir, ".git-config.json"), b, 0o600); err != nil {
		return err
	}
	// The sidecar holds the access token in plaintext — under no
	// circumstances should it land in the remote repo. Ensure
	// .gitignore covers it AND the local compile scratch dir.
	return ensureGitignore(projectDir, []string{
		".git-config.json",
		".weft-loom/",
	})
}

// ensureGitignore appends entries to <projectDir>/.gitignore that are
// not already present. Idempotent — re-saving the git config a second
// time leaves .gitignore unchanged. Preserves existing contents +
// trailing newline so user-added entries aren't disturbed.
func ensureGitignore(projectDir string, entries []string) error {
	path := filepath.Join(projectDir, ".gitignore")
	existing, _ := os.ReadFile(path) // tolerate not-found
	have := map[string]bool{}
	for _, line := range strings.Split(string(existing), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			have[trimmed] = true
		}
	}
	var add []string
	for _, e := range entries {
		if !have[e] {
			add = append(add, e)
		}
	}
	if len(add) == 0 {
		return nil
	}
	var buf strings.Builder
	buf.Write(existing)
	if len(existing) > 0 && existing[len(existing)-1] != '\n' {
		buf.WriteByte('\n')
	}
	if len(existing) > 0 {
		// Section comment makes the auto-managed block easy to spot
		// when reading .gitignore — operators know not to wipe it.
		buf.WriteString("\n# weft-loom auto-added\n")
	}
	for _, e := range add {
		buf.WriteString(e)
		buf.WriteByte('\n')
	}
	return os.WriteFile(path, []byte(buf.String()), 0o644)
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
