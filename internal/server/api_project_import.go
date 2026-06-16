package server

// api_project_import.go : one-click project import from a ZIP. The
// counterpart to api_project_export.go — accepts a multipart upload,
// walks every entry in the archive, and dispatches each non-directory
// entry through Projects.WriteFile so the storage backend stays
// abstract (LocalStore + PostgresStore both work).
//
//   POST /api/projects/{name}/import   (multipart/form-data, field "zip")
//        → { "imported": N, "skipped": M }
//
// By default we honour the same exportSkip prefix list as the export
// side : .weft-loom/ + .git/objects/pack/ are dropped on import too so
// a round-trip through the SPA stays clean. ?include=all bypasses
// the filter, mirroring the export query knob.
//
// Hard limits :
//   - 200 MiB request body, enforced via http.MaxBytesReader so a
//     huge upload doesn't sit in memory.
//   - Zip-slip defence : any entry whose cleaned path escapes the
//     project root (absolute, "..", "/") aborts the whole import
//     with 400 — partial-import on a hostile archive would leave the
//     caller in a confusing state.

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// maxImportSize caps the multipart upload at 200 MiB. Matches the
// 200 MB ceiling called out in the export header comment so the
// round-trip is symmetric.
const maxImportSize = 200 << 20

func (s *Server) handleProjectImport(w http.ResponseWriter, r *http.Request) {
	ident, _ := auth.IdentityFrom(r.Context())
	proj := projectName(r)
	includeAll := r.URL.Query().Get("include") == "all"

	// Hard cap on body size BEFORE multipart parsing — otherwise a
	// 10 GiB upload would buffer through ParseMultipartForm first.
	r.Body = http.MaxBytesReader(w, r.Body, maxImportSize)
	if err := r.ParseMultipartForm(maxImportSize); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	file, _, err := r.FormFile("zip")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing 'zip' form field"})
		return
	}
	defer file.Close()

	// archive/zip's Reader needs an io.ReaderAt + the total size, so
	// we have to materialise the upload. The MaxBytesReader above caps
	// the worst case at 200 MiB.
	buf, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid zip : " + err.Error()})
		return
	}

	var imported, skipped int
	for _, entry := range zr.File {
		// Skip directory entries — Projects.WriteFile creates parent
		// dirs implicitly. info.Mode().IsDir() is the canonical check
		// (some zip producers don't bother with the trailing slash).
		if entry.FileInfo().IsDir() {
			skipped++
			continue
		}
		clean, ok := safeImportPath(entry.Name)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "rejected entry (zip slip) : " + entry.Name,
			})
			return
		}
		// HARD skip : the server-side sidecar namespace is NEVER
		// writable through this endpoint, regardless of ?include=all.
		// Otherwise a hostile zip could ship a forged .weft-loom/owner
		// and elevate the importer to project owner. The dedicated
		// sharing/public-share APIs are the only legitimate path.
		if isInternalPath(clean) {
			skipped++
			continue
		}
		if !includeAll && skipExportPath(clean) {
			skipped++
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			skipped++
			continue
		}
		werr := s.opts.Projects.WriteFile(r.Context(), ident, proj, clean, rc)
		_ = rc.Close()
		if werr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": werr.Error()})
			return
		}
		imported++
	}

	writeJSON(w, http.StatusOK, map[string]int{
		"imported": imported,
		"skipped":  skipped,
	})
}

// safeImportPath defends against zip slip : an entry whose path
// (absolute, with ".." segments, with a leading slash, or empty)
// could escape the project root after the storage layer joins it.
// Returns the slash-cleaned relative path on success.
//
// We intentionally check on the RAW entry name as well as the cleaned
// form — a payload like "foo/../../etc/passwd" would clean to
// "../etc/passwd" and ALSO contain ".." in its components, both of
// which we reject.
func safeImportPath(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	// Forward-slash is the zip spec ; backslashes are non-standard +
	// commonly part of Windows-built archives that smuggle traversal.
	if strings.Contains(name, "\\") {
		return "", false
	}
	if strings.HasPrefix(name, "/") {
		return "", false
	}
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
		return "", false
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", false
		}
	}
	return clean, true
}

// Sentinel : ensures errors stays imported even if future refactors
// drop the only usage. Cheap belt-and-braces against import-cycle
// shuffles in this package.
var _ = errors.New
