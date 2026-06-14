package server

// api_project_export.go : one-click project export as a ZIP.
//
//   GET /api/projects/{name}/export.zip
//        → application/zip stream of every non-directory file in the
//          project, paths preserved as in ListFiles
//
// The handler streams the archive directly into the response so a
// 200 MB project doesn't materialise in memory. Files are picked up
// via Projects.ListFiles + ReadFile so the storage backend stays
// abstract (LocalStore + PostgresStore both work).
//
// Notably included :
//   - every file under the project root
// Notably skipped :
//   - .weft-loom/ (server-side history + label sidecars — internal)
//   - .git/objects/pack/ (binary pack files balloon the download ; the
//     loose object refs survive so a clone works)
//
// The "skip" list lives here as a const + applies to PATHS (not file
// contents). Callers can request unfiltered via ?include=all.

import (
	"archive/zip"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// exportSkip is the default deny-list of path prefixes. Anything
// starting with one of these is dropped from the archive unless the
// caller passes ?include=all.
var exportSkip = []string{
	".weft-loom/",
	".git/objects/pack/",
}

func (s *Server) handleProjectExport(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)
	includeAll := r.URL.Query().Get("include") == "all"

	files, err := s.opts.Projects.ListFiles(r.Context(), ident, proj)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Stream headers BEFORE creating the zip writer — once we start
	// writing zip bytes we can't change the status code.
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set(
		"Content-Disposition",
		`attachment; filename="`+sanitiseFor(proj)+`.zip"`,
	)
	// Disable nginx-style buffering so the client sees progress on
	// large archives.
	w.Header().Set("X-Accel-Buffering", "no")

	zw := zip.NewWriter(w)
	defer func() { _ = zw.Close() }()

	now := time.Now()
	for _, f := range files {
		if f.Dir {
			continue
		}
		if !includeAll && skipExportPath(f.Path) {
			continue
		}
		// Per-file open + copy. Skip on any open error so a single
		// unreadable file doesn't fail the whole archive.
		body, err := s.opts.Projects.ReadFile(r.Context(), ident, proj, f.Path)
		if err != nil {
			continue
		}
		hdr := &zip.FileHeader{
			Name:     f.Path,
			Method:   zip.Deflate,
			Modified: now,
		}
		fw, werr := zw.CreateHeader(hdr)
		if werr != nil {
			_ = body.Close()
			break
		}
		_, _ = io.Copy(fw, body)
		_ = body.Close()
	}
}

// skipExportPath returns true when `path` falls under one of the
// default-deny prefixes. Caller can override with ?include=all.
func skipExportPath(path string) bool {
	for _, prefix := range exportSkip {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}
