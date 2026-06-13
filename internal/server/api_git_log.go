package server

// api_git_log.go — git log endpoint backing the Source Graph subpanel.
// Returns a flat list of commits (HEAD-first) with parent SHAs so the
// SPA can paint the lane graph client-side. Capped at 200 commits to
// keep the response small ; pagination lands when the user asks for it.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	gitobject "github.com/go-git/go-git/v5/plumbing/object"

	"github.com/openweft/weft-loom-server/internal/auth"
)

type gitLogEntry struct {
	SHA        string   `json:"sha"`
	Parents    []string `json:"parents"`
	Author     string   `json:"author"`
	Email      string   `json:"email"`
	Subject    string   `json:"subject"`
	UnixTime   int64    `json:"unix_time"`
	RefNames   []string `json:"ref_names,omitempty"` // tags + branches pointing here
}

type gitLogResponse struct {
	Entries []gitLogEntry `json:"entries"`
	HeadSHA string        `json:"head_sha"`
	Branch  string        `json:"branch"`
}

func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	dir, err := s.projectWorkingDir(ident, projectName(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	limit := 200
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	repo, err := git.PlainOpen(dir)
	if err != nil {
		if errors.Is(err, git.ErrRepositoryNotExists) {
			// No git repo → empty graph, not an error.
			_ = json.NewEncoder(w).Encode(gitLogResponse{})
			return
		}
		http.Error(w, "open repo: "+err.Error(), http.StatusInternalServerError)
		return
	}
	head, err := repo.Head()
	if err != nil {
		// Empty repo (no commits yet) → empty graph.
		_ = json.NewEncoder(w).Encode(gitLogResponse{})
		return
	}
	iter, err := repo.Log(&git.LogOptions{From: head.Hash()})
	if err != nil {
		http.Error(w, "log: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer iter.Close()

	// Build a SHA → ref-names index so each commit can list the
	// branches / tags that point at it (decorations in VSCode's
	// Source Graph).
	decor := map[string][]string{}
	if refs, err := repo.References(); err == nil {
		_ = refs.ForEach(func(ref *plumbing.Reference) error {
			if ref.Type() != plumbing.HashReference {
				return nil
			}
			n := ref.Name()
			if n.IsBranch() || n.IsTag() || n.IsRemote() {
				decor[ref.Hash().String()] = append(
					decor[ref.Hash().String()],
					n.Short(),
				)
			}
			return nil
		})
	}

	// Initialised to an empty slice so the JSON encoder emits `[]`
	// rather than `null` for a fresh repo with no commits — the
	// SPA's lane-graph reducer reads `.length` directly.
	entries := []gitLogEntry{}
	count := 0
	_ = iter.ForEach(func(c *gitobject.Commit) error {
		if count >= limit {
			return fmt.Errorf("limit")
		}
		count++
		parents := make([]string, 0, len(c.ParentHashes))
		for _, p := range c.ParentHashes {
			parents = append(parents, p.String())
		}
		entries = append(entries, gitLogEntry{
			SHA:      c.Hash.String(),
			Parents:  parents,
			Author:   c.Author.Name,
			Email:    c.Author.Email,
			Subject:  firstLine(c.Message),
			UnixTime: c.Author.When.Unix(),
			RefNames: decor[c.Hash.String()],
		})
		return nil
	})

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(gitLogResponse{
		Entries: entries,
		HeadSHA: head.Hash().String(),
		Branch:  head.Name().Short(),
	})
}

func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}
