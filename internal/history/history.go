// Package history persists per-file text-snapshot timelines so users
// can scrub back through edits + restore prior versions. V0.1 stores
// snapshots as one JSONL line per snapshot under :
//
//	<projectDir>/.weft-loom/history/<urlencoded-file>.jsonl
//
// Each line is {ts, author, size, content}. content is the full text
// (we're optimising for simplicity, not storage — a 50 KB doc with
// 100 snapshots is 5 MB, manageable for the V0.1 use case).
//
// Snapshots are debounced : at most one per snapshotInterval per file.
// The hook is called from handleWriteFile after every successful write
// and the debounce decides whether to actually persist.
package history

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// snapshotInterval bounds the rate at which we capture new history
// entries. 30 s is empirically a good debounce — covers typical edit
// bursts without flooding the timeline.
const snapshotInterval = 30 * time.Second

// maxSnapshots caps how many entries we keep per file. Older entries
// roll off when the cap is exceeded.
const maxSnapshots = 200

// Entry is one row of a file's history timeline.
type Entry struct {
	TS      time.Time `json:"ts"`
	Author  string    `json:"author"`
	Size    int       `json:"size"`
	Content string    `json:"content,omitempty"`
}

// Store provides per-project history persistence.
type Store struct {
	mu       sync.Mutex
	lastSnap map[string]time.Time
}

// New returns an empty Store. Callers usually own one Store per
// server process.
func New() *Store {
	return &Store{lastSnap: make(map[string]time.Time)}
}

// historyDir returns the dir holding all history sidecar files for
// a project.
func historyDir(projectDir string) string {
	return filepath.Join(projectDir, ".weft-loom", "history")
}

// historyFile returns the JSONL path for a single file's timeline.
// URL-encode the path so subdirectory separators don't accidentally
// create directories.
func historyFile(projectDir, file string) string {
	return filepath.Join(historyDir(projectDir), url.PathEscape(file)+".jsonl")
}

// Append snapshots `content` for `file` if at least snapshotInterval
// has passed since the last snapshot for this (projectDir, file)
// pair. Returns (true, nil) when a snapshot was written, (false, nil)
// when debounced. Errors from the I/O path are returned verbatim so
// the caller can surface them to the event bus.
func (s *Store) Append(projectDir, file, author string, content []byte) (bool, error) {
	if projectDir == "" {
		return false, errors.New("history: projectDir is empty")
	}
	key := projectDir + "|" + file
	now := time.Now()
	s.mu.Lock()
	last, ok := s.lastSnap[key]
	if ok && now.Sub(last) < snapshotInterval {
		s.mu.Unlock()
		return false, nil
	}
	s.lastSnap[key] = now
	s.mu.Unlock()

	// Skip binary content — only snapshot text. Detect via NUL byte.
	if isBinary(content) {
		return false, nil
	}

	if err := os.MkdirAll(historyDir(projectDir), 0o755); err != nil {
		return false, fmt.Errorf("history: mkdir: %w", err)
	}
	entry := Entry{
		TS:      now,
		Author:  author,
		Size:    len(content),
		Content: string(content),
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return false, fmt.Errorf("history: marshal: %w", err)
	}
	path := historyFile(projectDir, file)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return false, fmt.Errorf("history: open: %w", err)
	}
	if _, werr := f.Write(append(line, '\n')); werr != nil {
		_ = f.Close()
		return false, fmt.Errorf("history: write: %w", werr)
	}
	if cerr := f.Close(); cerr != nil {
		return false, fmt.Errorf("history: close: %w", cerr)
	}
	// Best-effort cap : if the file now exceeds maxSnapshots lines,
	// rewrite keeping only the most recent maxSnapshots.
	go s.trim(path)
	return true, nil
}

// List returns the timeline for a file, newest first. Content is
// elided to keep the listing response small ; use Snapshot to fetch
// a single entry's text.
func (s *Store) List(projectDir, file string) ([]Entry, error) {
	path := historyFile(projectDir, file)
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []Entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var e Entry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			continue
		}
		e.Content = "" // elide
		out = append(out, e)
	}
	// Newest first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, sc.Err()
}

// Snapshot returns the entry with the matching TS (or the closest
// earlier one if exact match isn't found — clients pass the TS they
// got from List verbatim, but allow a tiny tolerance for serialisation
// round-trips). Includes the full Content.
func (s *Store) Snapshot(projectDir, file string, at time.Time) (Entry, error) {
	path := historyFile(projectDir, file)
	f, err := os.Open(path)
	if err != nil {
		return Entry{}, err
	}
	defer f.Close()
	var best Entry
	var found bool
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var e Entry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			continue
		}
		// Exact match wins immediately.
		if e.TS.Equal(at) {
			return e, nil
		}
		// Otherwise track the closest-earlier entry as fallback.
		if !e.TS.After(at) && (!found || e.TS.After(best.TS)) {
			best = e
			found = true
		}
	}
	if !found {
		return Entry{}, fmt.Errorf("history: no snapshot at or before %s", at.Format(time.RFC3339))
	}
	return best, nil
}

// trim keeps only the last maxSnapshots lines of the timeline.
// Runs in a goroutine so it doesn't block the write path.
func (s *Store) trim(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := strings.Split(string(b), "\n")
	// strings.Split leaves a trailing empty element after the final \n.
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	if len(lines) <= maxSnapshots {
		return
	}
	keep := lines[len(lines)-maxSnapshots:]
	out := strings.Join(keep, "\n") + "\n"
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(out), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// isBinary returns true when `content` looks like binary data (any
// NUL byte in the first 8 KB). Text files practically never contain
// NUL ; binary files almost always do.
func isBinary(content []byte) bool {
	end := len(content)
	if end > 8192 {
		end = 8192
	}
	for i := 0; i < end; i++ {
		if content[i] == 0 {
			return true
		}
	}
	return false
}

// HumanLabel returns a human-friendly label for an Entry. Used by the
// SPA when full localisation isn't worth it.
func HumanLabel(e Entry) string {
	if e.Author == "" {
		return e.TS.Format(time.RFC3339)
	}
	return fmt.Sprintf("%s by %s", e.TS.Format(time.RFC3339), e.Author)
}

// ReadAll returns the raw file contents for testing.
func ReadAll(projectDir, file string) ([]byte, error) {
	f, err := os.Open(historyFile(projectDir, file))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}
