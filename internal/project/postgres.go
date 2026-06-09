package project

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// PostgresStore is the HA-aware project store : metadata lives in
// PostgreSQL (weft-ha-postgresql handles the failover / replication)
// and file content lives on a shared weft-block volume mounted at
// `filesRoot` on every loom-server replica. The two paths are kept
// in sync transactionally — every WriteFile bumps the projects.updated_at
// row in the SAME transaction as the file landing on disk via
// rename-or-fsync, so a crash mid-write leaves the row pointing at
// the previous content (or the row is rolled back).
//
// Schema migrations run on NewPostgresStore via embedded SQL — see
// schema.sql. The store IS idempotent across restarts.
type PostgresStore struct {
	db        *pgxpool.Pool
	filesRoot string
}

//go:embed schema.sql
var schemaSQL string

// NewPostgresStore connects to dsn, runs migrations, and returns a
// ready store. filesRoot is the mount point of the shared volume
// (typically /var/lib/weft-loom on the microVM ; the volume itself
// is provisioned by weft-block as a replicated 3-DC volume).
func NewPostgresStore(ctx context.Context, dsn, filesRoot string) (*PostgresStore, error) {
	if dsn == "" {
		return nil, errors.New("postgres: DSN required")
	}
	if filesRoot == "" {
		return nil, errors.New("postgres: filesRoot required")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	// Idempotent CREATE TABLE IF NOT EXISTS — fine to run on every
	// boot and on every replica concurrently (the IF NOT EXISTS
	// clauses serialise on the catalog).
	if _, err := pool.Exec(ctx, schemaSQL); err != nil {
		pool.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	if err := os.MkdirAll(filesRoot, 0o755); err != nil {
		pool.Close()
		return nil, fmt.Errorf("filesRoot mkdir: %w", err)
	}
	return &PostgresStore{db: pool, filesRoot: filesRoot}, nil
}

// Close drops the connection pool. Safe to call multiple times.
func (s *PostgresStore) Close() { s.db.Close() }

// projectDir composes <filesRoot>/<sanitised-owner>/<sanitised-name>.
// We sanitise the owner subject (dex subjects can be URLs) for the
// filesystem ; the database is the authoritative ACL — the filesystem
// layout is just a sharding heuristic that keeps directory listings
// snappy.
func (s *PostgresStore) projectDir(ident auth.Identity, name string) string {
	return filepath.Join(s.filesRoot, sanitise(ident.Subject), sanitise(name))
}

func (s *PostgresStore) List(ctx context.Context, ident auth.Identity) ([]Project, error) {
	if ident.Subject == "" {
		return nil, ErrAccessDenied
	}
	rows, err := s.db.Query(ctx, `
		SELECT name, COALESCE(language, ''), created_at
		FROM   projects
		WHERE  owner_subject = $1
		ORDER  BY name`, ident.Subject)
	if err != nil {
		return nil, fmt.Errorf("list: %w", err)
	}
	defer rows.Close()
	out := make([]Project, 0)
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.Name, &p.Language, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *PostgresStore) ListFiles(ctx context.Context, ident auth.Identity, project string) ([]File, error) {
	if err := s.authorize(ctx, ident, project); err != nil {
		return nil, err
	}
	dir := s.projectDir(ident, project)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return []File{}, nil
	}
	out := []File{}
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		info, _ := d.Info()
		out = append(out, File{Path: rel, Size: info.Size(), Dir: d.IsDir()})
		return nil
	})
	return out, err
}

func (s *PostgresStore) ReadFile(ctx context.Context, ident auth.Identity, project, path string) (io.ReadCloser, error) {
	if err := s.authorize(ctx, ident, project); err != nil {
		return nil, err
	}
	full, err := s.resolveFile(ident, project, path)
	if err != nil {
		return nil, err
	}
	return os.Open(full)
}

func (s *PostgresStore) WriteFile(ctx context.Context, ident auth.Identity, project, path string, body io.Reader) error {
	if ident.Subject == "" {
		return ErrAccessDenied
	}
	full, err := s.resolveFile(ident, project, path)
	if err != nil {
		return err
	}
	// Upsert the project row (creates on first write ; updates on
	// every subsequent write). Inside a transaction so the file
	// rename can roll back if anything goes wrong.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("tx begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	lang := detectLanguageFromPath(path)
	if _, err := tx.Exec(ctx, `
		INSERT INTO projects (owner_subject, name, language)
		VALUES ($1, $2, NULLIF($3, ''))
		ON CONFLICT (owner_subject, name) DO UPDATE
		   SET updated_at = NOW(),
		       language = COALESCE(projects.language, EXCLUDED.language)`,
		ident.Subject, project, lang); err != nil {
		return fmt.Errorf("upsert project: %w", err)
	}
	// File landing : tempfile + rename so a crash mid-write doesn't
	// truncate the previous content. The fsync on the rename pairs
	// with the SQL commit for crash-consistency.
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".tmp-*")
	if err != nil {
		return fmt.Errorf("tempfile: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := io.Copy(tmp, body); err != nil {
		tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpName, full); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return tx.Commit(ctx)
}

// DeleteFile removes the on-disk file. Idempotent on missing paths.
// Doesn't bump the project's updated_at row — the V0.2 schema keeps
// file-level state in the filesystem ; future per-file metadata
// (history, last_modified_by) will move that bookkeeping here.
func (s *PostgresStore) DeleteFile(ctx context.Context, ident auth.Identity, project, path string) error {
	if ident.Subject == "" {
		return ErrAccessDenied
	}
	if err := s.authorize(ctx, ident, project); err != nil {
		return err
	}
	full, err := s.resolveFile(ident, project, path)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// authorize : caller must own the project. V0.3 will widen this to
// project ACL via dex groups ; V0.2.1 keeps the per-owner gate that
// LocalStore enforces too.
func (s *PostgresStore) authorize(ctx context.Context, ident auth.Identity, project string) error {
	if ident.Subject == "" {
		return ErrAccessDenied
	}
	var exists bool
	err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM projects
			WHERE owner_subject = $1 AND name = $2
		)`, ident.Subject, project).Scan(&exists)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !exists {
		// Returning ErrAccessDenied (not "not found") so a probing
		// caller can't enumerate which project names exist for
		// other tenants by reading 404 vs 403.
		return ErrAccessDenied
	}
	return nil
}

// resolveFile composes the safe full path. Mirror of LocalStore's
// version — same rules, same protections (no .., no abs paths).
func (s *PostgresStore) resolveFile(ident auth.Identity, project, path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("project: empty path")
	}
	if filepath.IsAbs(path) {
		return "", ErrAccessDenied
	}
	for _, seg := range strings.Split(filepath.ToSlash(path), "/") {
		if seg == ".." {
			return "", ErrAccessDenied
		}
	}
	dir := s.projectDir(ident, project)
	full := filepath.Join(dir, filepath.Clean(path))
	rel, err := filepath.Rel(dir, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", ErrAccessDenied
	}
	return full, nil
}

// detectLanguageFromPath is the WriteFile-time language hint. Mirror
// of detectLanguage (LocalStore) keyed on the file being written, not
// on the directory contents — the upsert happens BEFORE the file
// lands, so we can't filesystem-probe yet.
func detectLanguageFromPath(p string) string {
	base := filepath.Base(p)
	switch base {
	case "main.tex":
		return "latex"
	case "go.mod":
		return "go"
	case "package.json":
		return "javascript"
	case "Cargo.toml":
		return "rust"
	case "CMakeLists.txt":
		return "cpp"
	case "requirements.txt", "pyproject.toml":
		return "python"
	case "README.md":
		return "markdown"
	}
	return ""
}

// Compile-time check that PostgresStore implements Store.
var _ Store = (*PostgresStore)(nil)
