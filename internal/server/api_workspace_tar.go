package server

// api_workspace_tar.go — boot-time + on-demand HTTP delivery of the
// user's project storage as a tar stream. The workspace μVM's init
// fetches this at startup via the host loopback (10.0.2.2) so the
// shell at /workspace sees the user's actual project files even
// without a virtio-9p bridge (broken on macOS dev — see
// project_weft_loom_v04_arch memory).
//
// Wire :
//   GET /api/internal/workspace-tar/{vmid}
//     200 + tar stream of <storage_root>/<subject(vmid)>/
//     404 if vmid is unknown
//
// Security : the route is wrapped by requireAuth so the caller's
// identity is always present. We then re-derive the expected vmid
// from the caller via workspace.VMIDForIdentity and refuse with 403
// when the URL's {vmid} doesn't match — a logged-in user can only
// fetch their own workspace tar, never someone else's, even when the
// listener is exposed off-loopback.

import (
	"archive/tar"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
	"github.com/openweft/weft-loom-server/internal/workspace"
)

// resolveSubjectByVMID reverses workspace.VMIDForIdentity to find
// which on-disk user dir the VM should see. Since the hash isn't
// reversible, we scan the storage root for matching candidates ;
// in practice loom-server has 1 user per dev box so this is O(1).
func (s *Server) resolveSubjectByVMID(vmid string) (string, error) {
	root := os.Getenv("WEFT_LOOM_STORAGE_ROOT")
	if root == "" {
		root = "/tmp/weft-loom-data"
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("read storage root %s: %w", root, err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if workspace.VMIDForIdentity(workspace.Identity{Subject: e.Name()}) == vmid {
			return filepath.Join(root, e.Name()), nil
		}
	}
	return "", fmt.Errorf("no subject mapped to vmid %s", vmid)
}

func (s *Server) handleWorkspaceTar(w http.ResponseWriter, r *http.Request) {
	vmid := r.PathValue("vmid")
	if vmid == "" {
		http.Error(w, "vmid required", http.StatusBadRequest)
		return
	}
	// Defence in depth : the caller's identity is already injected by
	// requireAuth, so re-derive the expected vmid + reject anything
	// the caller doesn't own.
	ident, _ := auth.IdentityFrom(r.Context())
	expected := workspace.VMIDForIdentity(workspace.Identity{Subject: ident.Subject})
	if expected != vmid {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "workspace", Verb: "tar.identity_mismatch",
			Level:  "warn",
			Fields: map[string]any{"vmid": vmid, "subject": ident.Subject, "expected": expected},
		})
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	dir, err := s.resolveSubjectByVMID(vmid)
	if err != nil {
		s.events.Publish(eventbus.Event{
			Source: "server", Component: "workspace", Verb: "tar.unknown_vmid",
			Level:  "warn", Fields: map[string]any{"vmid": vmid, "err": err.Error()},
		})
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Cache-Control", "no-cache")
	tw := tar.NewWriter(w)
	defer tw.Close()

	var bytesOut, filesOut int64
	walkErr := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Skip the scratch dir compile jobs use ; .git is intentionally
		// included so the shell can run git commands.
		rel, _ := filepath.Rel(dir, path)
		if strings.HasPrefix(rel, ".weft-loom") {
			return filepath.SkipDir
		}
		if rel == "" || rel == "." {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = rel
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		n, err := io.Copy(tw, f)
		bytesOut += n
		filesOut++
		return err
	})
	if walkErr != nil {
		// Best-effort : log but don't panic mid-stream — the agent
		// gets a truncated tar it can still partially extract.
		if s.opts.Logger != nil {
			s.opts.Logger.Warn("workspace tar walk error", "dir", dir, "err", walkErr)
		}
	}
	s.events.Publish(eventbus.Event{
		Source: "server", Component: "workspace", Verb: "tar.served",
		Fields: map[string]any{"vmid": vmid, "files": filesOut, "bytes": bytesOut},
	})
}
