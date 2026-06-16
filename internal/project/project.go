// Package project owns project-file storage. V0.1 ships one backend
// (local filesystem rooted at a configured path) ; V0.2 adds a
// weft-block backend so per-project volumes mount into compile
// microVMs without round-tripping through the host filesystem.
//
// The Store interface centralises authorization : every method takes
// the caller's Identity, and the implementation enforces "can this
// user see/edit this project". V0.1 policy : project owner subject ==
// identity.Subject OR identity.Groups contains "loom-admin". V0.2
// migrates to openweft project ACL via dex groups.
package project

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// Project is the summary returned by List.
type Project struct {
	Name      string    `json:"name"`
	Language  string    `json:"language"`
	CreatedAt time.Time `json:"created_at"`
}

// File is one entry in ListFiles.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Dir  bool   `json:"dir"`
}

// Store is the storage abstraction.
type Store interface {
	List(ctx context.Context, ident auth.Identity) ([]Project, error)
	ListFiles(ctx context.Context, ident auth.Identity, project string) ([]File, error)
	ReadFile(ctx context.Context, ident auth.Identity, project, path string) (io.ReadCloser, error)
	WriteFile(ctx context.Context, ident auth.Identity, project, path string, body io.Reader) error
	DeleteFile(ctx context.Context, ident auth.Identity, project, path string) error
	// Rename moves a project from oldName to newName for the caller.
	// Implementations refuse if newName already exists and propagate
	// ErrInvalidName for malformed targets. Sidecars under
	// .weft-loom/ (sharing.json, owner) travel with the directory ;
	// git remotes stay attached because git is content-addressed.
	Rename(ctx context.Context, ident auth.Identity, oldName, newName string) error
}

// ErrAccessDenied is returned by Store impls when the caller lacks
// permission. Handlers translate to 403.
var ErrAccessDenied = errors.New("project: access denied")

// ErrProjectExists is returned by Rename when the destination name is
// already taken. Handlers translate to 409.
var ErrProjectExists = errors.New("project: destination name already exists")

// ErrInvalidName is returned by Rename when the destination name is
// empty, sanitises to empty, or matches the .weft-loom reserved
// sidecar prefix. Handlers translate to 400.
var ErrInvalidName = errors.New("project: invalid name")

// ErrNotFound is returned by Rename when the source project doesn't
// exist on disk. Handlers translate to 404.
var ErrNotFound = errors.New("project: not found")

// LocalStore is the V0.1 backend : projects live under <root>/<owner>/<name>.
// Owner is identity.Subject ; the subject is sanitised to a safe
// filesystem name (alphanumeric + dash + underscore) so dex's "subject
// can be a URL" doesn't escape the root.
type LocalStore struct {
	root string
}

// Root exposes the configured filesystem root for callers that need
// to materialise per-project paths outside the Store interface — e.g.
// the V0.3 git surface drives go-git directly against the working
// tree under <root>/<owner>/<project>. The Store interface stays
// backend-agnostic ; this is a deliberate LocalStore-specific
// extension and a future S3 backend will simply not satisfy it.
func (s *LocalStore) Root() string { return s.root }

// NewLocalStore returns a store rooted at the given absolute path.
// The directory is created on first write.
func NewLocalStore(root string) *LocalStore {
	return &LocalStore{root: root}
}

// userRoot returns the per-identity storage root, mkdir'd lazily.
func (s *LocalStore) userRoot(ident auth.Identity) (string, error) {
	if ident.Subject == "" {
		return "", ErrAccessDenied
	}
	return filepath.Join(s.root, sanitise(ident.Subject)), nil
}

func (s *LocalStore) List(_ context.Context, ident auth.Identity) ([]Project, error) {
	u, err := s.userRoot(ident)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(u); os.IsNotExist(err) {
		return []Project{}, nil
	}
	entries, err := os.ReadDir(u)
	if err != nil {
		return nil, err
	}
	out := make([]Project, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, _ := e.Info()
		out = append(out, Project{
			Name:      e.Name(),
			Language:  detectLanguage(filepath.Join(u, e.Name())),
			CreatedAt: info.ModTime(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *LocalStore) ListFiles(_ context.Context, ident auth.Identity, project string) ([]File, error) {
	dir, err := s.projectDir(ident, project)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return []File{}, nil
	}
	out := []File{}
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		info, _ := d.Info()
		out = append(out, File{
			Path: rel,
			Size: info.Size(),
			Dir:  d.IsDir(),
		})
		return nil
	})
	return out, err
}

func (s *LocalStore) ReadFile(_ context.Context, ident auth.Identity, project, path string) (io.ReadCloser, error) {
	full, err := s.resolveFile(ident, project, path)
	if err != nil {
		return nil, err
	}
	return os.Open(full)
}

func (s *LocalStore) WriteFile(_ context.Context, ident auth.Identity, project, path string, body io.Reader) (err error) {
	full, err := s.resolveFile(ident, project, path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	if _, err = io.Copy(f, body); err != nil {
		return err
	}
	return f.Sync()
}

// DeleteFile removes <user>/<project>/<path>. Idempotent on missing
// paths : returns nil even if the file is already gone, so a
// concurrent delete from another browser tab doesn't bubble up as an
// error to the UI. Traversal-safe via resolveFile.
func (s *LocalStore) DeleteFile(_ context.Context, ident auth.Identity, project, path string) error {
	full, err := s.resolveFile(ident, project, path)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Rename moves <root>/<owner>/<oldName> to <root>/<owner>/<newName>.
// The whole directory (including .weft-loom/ sidecars and the .git
// dir) travels atomically via os.Rename — git remains attached
// because git is content-addressed and the working directory name
// doesn't matter. Refuses if the destination already exists ; that
// gate is non-atomic vs concurrent Rename calls, but the second
// caller in a race loses on os.Rename itself (ENOTEMPTY on most
// filesystems) so we never silently overwrite.
func (s *LocalStore) Rename(_ context.Context, ident auth.Identity, oldName, newName string) error {
	if err := validateRenameTarget(newName); err != nil {
		return err
	}
	src, err := s.projectDir(ident, oldName)
	if err != nil {
		return err
	}
	dst, err := s.projectDir(ident, newName)
	if err != nil {
		return err
	}
	if src == dst {
		return ErrInvalidName
	}
	if _, err := os.Stat(src); os.IsNotExist(err) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return ErrProjectExists
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(src, dst)
}

// validateRenameTarget : non-empty, no path separators, not
// .weft-loom/ reserved name. Mirrors the sanitise() character set so
// the same names that round-trip through other Store methods also
// round-trip through Rename.
func validateRenameTarget(name string) error {
	if name == "" {
		return ErrInvalidName
	}
	if strings.ContainsAny(name, "/\\") {
		return ErrInvalidName
	}
	if name == ".weft-loom" || strings.HasPrefix(name, ".") {
		return ErrInvalidName
	}
	if sanitise(name) != name {
		return ErrInvalidName
	}
	return nil
}

// projectDir returns the absolute path to a project, validating that
// it doesn't escape the user root.
func (s *LocalStore) projectDir(ident auth.Identity, project string) (string, error) {
	u, err := s.userRoot(ident)
	if err != nil {
		return "", err
	}
	clean := sanitise(project)
	if clean == "" {
		return "", fmt.Errorf("project: invalid name")
	}
	return filepath.Join(u, clean), nil
}

// resolveFile composes <user>/<project>/<path> ensuring the result
// stays under the user root (no traversal). Rejects any path that
// contains a ".." segment outright — a project file can be at
// "src/main.tex" but never "src/../../etc/passwd". Absolute paths
// are also rejected so a malicious client can't bypass with leading
// "/".
func (s *LocalStore) resolveFile(ident auth.Identity, project, path string) (string, error) {
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
	dir, err := s.projectDir(ident, project)
	if err != nil {
		return "", err
	}
	full := filepath.Join(dir, filepath.Clean(path))
	// Defence in depth : if filepath.Clean somehow produced an escape,
	// reject. With ".." pre-rejected this is belt-and-braces.
	rel, err := filepath.Rel(dir, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", ErrAccessDenied
	}
	return full, nil
}

// sanitise reduces a string to filesystem-safe characters. Avoids
// directory traversal, path separators, dotfiles.
func sanitise(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-' || r == '_':
			b.WriteRune(r)
		}
	}
	return b.String()
}

// detectLanguage is a cheap heuristic for the project type ; the
// frontend uses it to pre-select the CodeMirror language pack. V0.2
// will read a .loom file in the project root with explicit language
// + build settings.
func detectLanguage(dir string) string {
	for _, m := range []struct {
		file, lang string
	}{
		{"main.tex", "latex"},
		{"go.mod", "go"},
		{"package.json", "javascript"},
		{"Cargo.toml", "rust"},
		{"CMakeLists.txt", "cpp"},
		{"requirements.txt", "python"},
		{"pyproject.toml", "python"},
		{"README.md", "markdown"},
	} {
		if _, err := os.Stat(filepath.Join(dir, m.file)); err == nil {
			return m.lang
		}
	}
	return ""
}
