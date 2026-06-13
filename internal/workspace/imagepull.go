// Package workspace : imagepull.go — fetch the base qcow2 from a
// GHCR OCI artifact, caching by digest under ~/.weft-loom/images/.
//
// Operators configure WEFT_WORKSPACE_BASE_QCOW2 with either :
//   - a local file path                 (legacy / dev shortcut)
//   - an OCI reference (e.g. ghcr.io/openweft/weft-loom-workspace-base:v0.5.1)
//
// The QEMUProvisioner calls ResolveBaseQcow2(ctx, ref) before booting
// a new VM. It returns the local path to a cached qcow2 — either
// the literal config path (when not an OCI ref) or the unpacked
// artifact layer under cacheDir. Idempotent : a second call for the
// same ref + digest is a no-op.
//
// The OCI artifact shape is what weft-loom-workspace's
// bake-qcow2.yml publishes :
//   - manifest mediatype : application/vnd.oci.image.manifest.v1+json
//   - one layer w/ mediatype application/vnd.openweft.workspace.qcow2.image
//   - layer blob = the raw qcow2 bytes (NOT a tarball)

package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	v1 "github.com/opencontainers/image-spec/specs-go/v1"
	"oras.land/oras-go/v2"
	"oras.land/oras-go/v2/content/memory"
	"oras.land/oras-go/v2/registry/remote"
)

// QcowImageMediaType is the OCI artifact layer mediatype the
// weft-loom-workspace bake publishes the qcow2 under.
const QcowImageMediaType = "application/vnd.openweft.workspace.qcow2.image"

// ImagePuller caches OCI artifact pulls under a per-host directory.
// One puller per loom-server lifetime ; concurrent ResolveBaseQcow2
// calls for the same digest share the cached file.
type ImagePuller struct {
	cacheDir string
	mu       sync.Mutex
	pulling  map[string]*sync.WaitGroup
}

// NewImagePuller builds the puller backed by cacheDir (auto-created
// on first pull). cacheDir == "" defaults to ~/.weft-loom/images/.
func NewImagePuller(cacheDir string) *ImagePuller {
	if cacheDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cacheDir = filepath.Join(home, ".weft-loom", "images")
		} else {
			cacheDir = "/tmp/weft-loom-images"
		}
	}
	return &ImagePuller{cacheDir: cacheDir, pulling: map[string]*sync.WaitGroup{}}
}

// ResolveBaseQcow2 returns the local path to the base qcow2 for ref.
// When ref is a local file path, returns it as-is. When ref looks
// like an OCI reference, pulls the artifact (or returns the cached
// path if the digest is already on disk).
func (p *ImagePuller) ResolveBaseQcow2(ctx context.Context, ref string) (string, error) {
	if ref == "" {
		return "", fmt.Errorf("base qcow2 ref required")
	}
	// Local path heuristic : OCI refs always contain a "/" + ":" or "@" pair ;
	// local paths are either absolute (start with "/") OR don't contain ":".
	if isLocalPath(ref) {
		if _, err := os.Stat(ref); err != nil {
			return "", fmt.Errorf("local base qcow2 %s: %w", ref, err)
		}
		return ref, nil
	}
	return p.pullOCI(ctx, ref)
}

// isLocalPath returns true when ref is unambiguously a local file
// path. Heuristic : starts with `/` OR `./` OR `../`, OR doesn't
// contain a `:` (so it can't be a `<registry>:<port>/<repo>:<tag>`
// shape). The OCI ecosystem doesn't have a tighter convention.
func isLocalPath(ref string) bool {
	if strings.HasPrefix(ref, "/") || strings.HasPrefix(ref, "./") || strings.HasPrefix(ref, "../") {
		return true
	}
	if !strings.Contains(ref, ":") {
		return true
	}
	// A few common registry hosts to disambiguate paths like
	// `localhost:5000/foo:bar` (registry) vs `relative/file:1.2`
	// (which is genuinely ambiguous and rare).
	for _, prefix := range []string{"ghcr.io/", "docker.io/", "quay.io/", "localhost:", "registry."} {
		if strings.HasPrefix(ref, prefix) {
			return false
		}
	}
	return false
}

// pullOCI does the work : open the remote registry, fetch the
// manifest, pick the qcow2 layer, save it to <cacheDir>/<digest>.qcow2.
// Concurrent callers for the same ref serialise on a per-ref WG.
func (p *ImagePuller) pullOCI(ctx context.Context, ref string) (string, error) {
	if err := os.MkdirAll(p.cacheDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir cache %s: %w", p.cacheDir, err)
	}

	// Per-ref serialisation. First arrival pulls ; everyone else
	// waits + reads from the cache.
	p.mu.Lock()
	wg, present := p.pulling[ref]
	if present {
		p.mu.Unlock()
		wg.Wait()
	} else {
		wg = &sync.WaitGroup{}
		wg.Add(1)
		p.pulling[ref] = wg
		p.mu.Unlock()
		defer func() {
			p.mu.Lock()
			delete(p.pulling, ref)
			p.mu.Unlock()
			wg.Done()
		}()
	}

	repo, err := remote.NewRepository(ref)
	if err != nil {
		return "", fmt.Errorf("parse ref %q: %w", ref, err)
	}
	// PlainHTTP defaults to false ; the registry's protocol comes
	// from the host header heuristic in oras-go.
	store := memory.New()
	manifestDesc, err := oras.Copy(ctx, repo, repo.Reference.Reference, store, "", oras.DefaultCopyOptions)
	if err != nil {
		return "", fmt.Errorf("oras copy %q: %w", ref, err)
	}

	rc, err := store.Fetch(ctx, manifestDesc)
	if err != nil {
		return "", fmt.Errorf("fetch manifest: %w", err)
	}
	manifestBytes, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		return "", fmt.Errorf("read manifest: %w", err)
	}
	var manifest v1.Manifest
	if err := unmarshalManifest(manifestBytes, &manifest); err != nil {
		return "", fmt.Errorf("decode manifest: %w", err)
	}

	for _, layer := range manifest.Layers {
		if layer.MediaType != QcowImageMediaType {
			continue
		}
		// Cache hit ?
		cachePath := filepath.Join(p.cacheDir, hashName(layer.Digest.String())+".qcow2")
		if _, err := os.Stat(cachePath); err == nil {
			return cachePath, nil
		}
		// Stream the layer blob into the cache file.
		brc, err := store.Fetch(ctx, layer)
		if err != nil {
			return "", fmt.Errorf("fetch qcow2 layer: %w", err)
		}
		defer brc.Close()
		tmp := cachePath + ".tmp"
		f, err := os.Create(tmp)
		if err != nil {
			return "", fmt.Errorf("create cache %s: %w", tmp, err)
		}
		if _, err := io.Copy(f, brc); err != nil {
			f.Close()
			os.Remove(tmp)
			return "", fmt.Errorf("write cache %s: %w", tmp, err)
		}
		if err := f.Close(); err != nil {
			os.Remove(tmp)
			return "", fmt.Errorf("close cache %s: %w", tmp, err)
		}
		if err := os.Rename(tmp, cachePath); err != nil {
			os.Remove(tmp)
			return "", fmt.Errorf("rename cache %s -> %s: %w", tmp, cachePath, err)
		}
		return cachePath, nil
	}
	return "", fmt.Errorf("manifest %s has no layer with mediatype %s", manifestDesc.Digest, QcowImageMediaType)
}

// hashName makes a filesystem-safe filename from an OCI digest.
// Digest shape is "sha256:<64 hex>" ; we drop the colon so the file
// name doesn't trip macOS Finder + Windows.
func hashName(digest string) string {
	h := sha256.Sum256([]byte(digest))
	return hex.EncodeToString(h[:8])
}
