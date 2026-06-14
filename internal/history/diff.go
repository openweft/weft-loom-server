package history

// Pure-Go line-based diff for the change-history UI. Implements
// Hunt-McIlroy LCS over line vectors, then collapses the resulting
// edit script into hunks of {add, remove, context} lines for
// rendering. No external deps so the loom-server package graph
// stays clean.
//
// We're not trying to compete with sergi/go-diff or git's
// myers-greedy — the input is a text file (typically < 1 MB) and the
// UI doesn't need character-level granularity. Line-level diff is
// what every code-review surface shows, and LCS is O(NM) which is
// fine at < 10 k lines per file.

import "strings"

// DiffLine is one line of the resulting diff.
type DiffLine struct {
	Kind string `json:"kind"` // "add" | "remove" | "context"
	Text string `json:"text"`
	// OldLineNum / NewLineNum are 1-indexed line numbers in the
	// respective version. -1 when the line doesn't exist in that
	// version (an "add" has no OldLineNum, a "remove" has no
	// NewLineNum).
	OldLineNum int `json:"oldLineNum"`
	NewLineNum int `json:"newLineNum"`
}

// Hunk is a contiguous region of changed lines with up to ContextLines
// context above + below. Two hunks separated by more than 2*ContextLines
// of common content are kept distinct so the UI can render them with
// "..." separators.
type Hunk struct {
	OldStart int        `json:"oldStart"` // 1-indexed
	NewStart int        `json:"newStart"`
	Lines    []DiffLine `json:"lines"`
}

// ContextLines is how many surrounding common lines each hunk
// includes. Matches `git diff -U3`'s default.
const ContextLines = 3

// DiffLines returns a unified-style diff of `from` vs `to` as a
// slice of hunks. Empty result means the inputs are identical.
func DiffLines(from, to string) []Hunk {
	a := splitLines(from)
	b := splitLines(to)
	script := editScript(a, b)
	return collapseHunks(script)
}

// splitLines splits on '\n'. Trailing empty entry after a final
// newline is dropped so two identical files (one with trailing
// newline, one without) only differ on the last line if it actually
// differs.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	if n := len(parts); n > 0 && parts[n-1] == "" {
		parts = parts[:n-1]
	}
	return parts
}

// editScript runs LCS-then-backtrack over a and b. Result is a flat
// sequence of DiffLine ; "context" entries appear for runs the
// inputs share, "add" / "remove" for divergences.
func editScript(a, b []string) []DiffLine {
	n, m := len(a), len(b)
	// LCS table (rows = a, cols = b). Standard O(NM) DP.
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := 0; i < n; i++ {
		for j := 0; j < m; j++ {
			if a[i] == b[j] {
				dp[i+1][j+1] = dp[i][j] + 1
			} else if dp[i][j+1] >= dp[i+1][j] {
				dp[i+1][j+1] = dp[i][j+1]
			} else {
				dp[i+1][j+1] = dp[i+1][j]
			}
		}
	}
	// Backtrack into a reversed edit script ; we'll flip at the end.
	var out []DiffLine
	i, j := n, m
	for i > 0 && j > 0 {
		if a[i-1] == b[j-1] {
			out = append(out, DiffLine{Kind: "context", Text: a[i-1], OldLineNum: i, NewLineNum: j})
			i--
			j--
		} else if dp[i-1][j] >= dp[i][j-1] {
			out = append(out, DiffLine{Kind: "remove", Text: a[i-1], OldLineNum: i, NewLineNum: -1})
			i--
		} else {
			out = append(out, DiffLine{Kind: "add", Text: b[j-1], OldLineNum: -1, NewLineNum: j})
			j--
		}
	}
	for ; i > 0; i-- {
		out = append(out, DiffLine{Kind: "remove", Text: a[i-1], OldLineNum: i, NewLineNum: -1})
	}
	for ; j > 0; j-- {
		out = append(out, DiffLine{Kind: "add", Text: b[j-1], OldLineNum: -1, NewLineNum: j})
	}
	// Reverse.
	for k, l := 0, len(out)-1; k < l; k, l = k+1, l-1 {
		out[k], out[l] = out[l], out[k]
	}
	return out
}

// collapseHunks splits the flat edit script into hunks with at most
// ContextLines of context each side. Runs of pure context longer
// than 2*ContextLines + 1 between two change regions get split.
func collapseHunks(script []DiffLine) []Hunk {
	if len(script) == 0 {
		return nil
	}
	// Find indices of change lines.
	var changes []int
	for i, l := range script {
		if l.Kind != "context" {
			changes = append(changes, i)
		}
	}
	if len(changes) == 0 {
		return nil
	}
	// Group consecutive changes whose surrounding context overlaps
	// (gap ≤ 2 * ContextLines).
	type group struct{ start, end int }
	var groups []group
	cur := group{start: changes[0], end: changes[0]}
	for _, idx := range changes[1:] {
		if idx-cur.end <= 2*ContextLines {
			cur.end = idx
		} else {
			groups = append(groups, cur)
			cur = group{start: idx, end: idx}
		}
	}
	groups = append(groups, cur)
	var hunks []Hunk
	for _, g := range groups {
		lo := g.start - ContextLines
		if lo < 0 {
			lo = 0
		}
		hi := g.end + ContextLines + 1
		if hi > len(script) {
			hi = len(script)
		}
		// Find the 1-indexed start lines for this hunk.
		var oldStart, newStart int
		for k := lo; k < hi; k++ {
			if oldStart == 0 && script[k].OldLineNum > 0 {
				oldStart = script[k].OldLineNum
			}
			if newStart == 0 && script[k].NewLineNum > 0 {
				newStart = script[k].NewLineNum
			}
			if oldStart > 0 && newStart > 0 {
				break
			}
		}
		hunks = append(hunks, Hunk{
			OldStart: oldStart,
			NewStart: newStart,
			Lines:    append([]DiffLine{}, script[lo:hi]...),
		})
	}
	return hunks
}

// DiffSummary tallies the totals for a diff. Useful for compact
// list rendering.
type DiffSummary struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// SummariseDiff counts added / removed lines across hunks.
func SummariseDiff(hunks []Hunk) DiffSummary {
	var s DiffSummary
	for _, h := range hunks {
		for _, l := range h.Lines {
			if l.Kind == "add" {
				s.Added++
			} else if l.Kind == "remove" {
				s.Removed++
			}
		}
	}
	return s
}
