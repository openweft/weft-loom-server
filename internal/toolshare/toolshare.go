// Package toolshare pulls OCI tool images on the loom-server host
// and unpacks them under a single shared directory. Every workspace
// μVM mounts that directory at /opt/tools/ via virtio-9p (read-only,
// in prod via NBD off a weft-block volume per image with the same
// R/O semantics).
//
// Why share-then-mount instead of per-VM pull :
//   - texlive is ~5 GiB. Pulled once on the host is 5 GiB ; pulled
//     per-VM is 5 GiB × N users — and unpacked the same way.
//   - 9p R/O mount has near-zero startup cost. crun exec into the
//     bundle is microseconds. Per-VM pull is a >minute first hit.
//   - Image upgrade story : bump the symlink/digest on the host →
//     every VM's next exec picks up the new bytes. No coordinated
//     restart.
//   - Same wire as the existing /workspace 9p bridge ; we just add
//     a second `mount_tag=tools` device.
//
// Layout on the host :
//
//   <cache>/tools/<refSafe>/rootfs/   unpacked OCI rootfs (R/O)
//   <cache>/tools/<refSafe>/bundle/   pre-rendered config.json for crun exec
//   <cache>/tools/.current/<image>     symlink → <refSafe> (atomic upgrade)
//
// In the guest the same path is visible at /opt/tools/. Tool
// wrappers like /usr/local/bin/pdflatex do :
//   crun exec --bundle /opt/tools/.current/texlive/bundle texlive pdflatex "$@"

package toolshare

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	v1 "github.com/opencontainers/image-spec/specs-go/v1"
	"oras.land/oras-go/v2/registry/remote"
)

// Manager owns the per-image unpack lifecycle. One per loom-server.
// Concurrent Ensure for the same ref is deduped via a per-image WG.
type Manager struct {
	Root string
	mu       sync.Mutex
	pulling  map[string]*sync.WaitGroup
}

// New returns a Manager backed by root (auto-created on first Ensure).
// root == "" defaults to ~/.weft-loom/tools/.
func New(root string) *Manager {
	if root == "" {
		if home, err := os.UserHomeDir(); err == nil {
			root = filepath.Join(home, ".weft-loom", "tools")
		} else {
			root = "/var/lib/weft-loom/tools"
		}
	}
	return &Manager{Root: root, pulling: map[string]*sync.WaitGroup{}}
}

// ToolsPath returns the host path the guest's virtio-9p mount_tag=tools
// should bind. Caller passes this to QEMU.
func (m *Manager) ToolsPath() string { return m.Root }

// Ensure makes sure the image is pulled + unpacked. logicalName is
// the stable identifier the guest's tool wrappers reference (e.g.
// "texlive") ; ref is the OCI ref to pull. Idempotent : a second
// Ensure for the same ref is a no-op, a different ref under the
// same logicalName atomically flips the .current symlink.
func (m *Manager) Ensure(ctx context.Context, logicalName, ref string) error {
	if ref == "" || logicalName == "" {
		return fmt.Errorf("toolshare: logicalName + ref required")
	}
	if err := os.MkdirAll(m.Root, 0o755); err != nil {
		return fmt.Errorf("toolshare mkdir %s: %w", m.Root, err)
	}
	refSafe := refSafeName(ref)
	targetDir := filepath.Join(m.Root, refSafe)
	rootfsDir := filepath.Join(targetDir, "rootfs")

	// Deduplicate concurrent pulls.
	m.mu.Lock()
	wg, present := m.pulling[refSafe]
	if present {
		m.mu.Unlock()
		wg.Wait()
	} else {
		wg = &sync.WaitGroup{}
		wg.Add(1)
		m.pulling[refSafe] = wg
		m.mu.Unlock()
		defer func() {
			m.mu.Lock()
			delete(m.pulling, refSafe)
			m.mu.Unlock()
			wg.Done()
		}()
	}

	if _, err := os.Stat(rootfsDir); err == nil {
		// Already unpacked. Still flip .current to point here.
		return m.linkCurrent(logicalName, refSafe)
	}

	if err := os.MkdirAll(rootfsDir, 0o755); err != nil {
		return fmt.Errorf("toolshare mkdir rootfs: %w", err)
	}
	if err := pullAndExtract(ctx, ref, rootfsDir); err != nil {
		return fmt.Errorf("toolshare pull %s: %w", ref, err)
	}
	// Pre-create the mountpoints the bundle's config.json references.
	// The rootfs lives on a 9p read-only mount in the guest, so crun
	// can't mkdir them at runtime. /workspace + /proc + /sys + /dev
	// are the standard ones — many minimal images skip them.
	for _, mp := range []string{"workspace", "proc", "sys", "dev", "dev/pts"} {
		_ = os.MkdirAll(filepath.Join(rootfsDir, mp), 0o755)
	}
	if err := writeBundleConfig(targetDir, logicalName); err != nil {
		return fmt.Errorf("toolshare bundle: %w", err)
	}
	return m.linkCurrent(logicalName, refSafe)
}

// linkCurrent atomically points <root>/.current/<logicalName> at the
// freshly-unpacked dir so the guest's wrappers always see the right
// bundle without restarting the VM.
func (m *Manager) linkCurrent(logicalName, refSafe string) error {
	currentDir := filepath.Join(m.Root, ".current")
	if err := os.MkdirAll(currentDir, 0o755); err != nil {
		return err
	}
	link := filepath.Join(currentDir, logicalName)
	tmp := link + ".tmp"
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Join("..", refSafe), tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
}

func refSafeName(ref string) string {
	out := strings.NewReplacer("/", "-", ":", "-", "@", "-").Replace(ref)
	return out
}

// pullAndExtract streams each OCI layer directly from the registry
// + untars on the fly into rootfsDir. Crucial : we DO NOT buffer
// layers in memory. oras.Copy with memory.New() would hold every
// blob in RAM ; for a 770 MiB image (pandoc/latex) that blew past
// our budget and stalled the pull. Streaming Fetch keeps RAM flat.
//
// Handles multi-arch indices by picking the linux/arm64 (or amd64
// fallback) child manifest. Skips empty layers (foreign blobs)
// silently.
func pullAndExtract(ctx context.Context, ref, rootfsDir string) error {
	repo, err := remote.NewRepository(ref)
	if err != nil {
		return fmt.Errorf("parse ref: %w", err)
	}
	// Resolve the root descriptor : Resolve fetches the manifest
	// metadata via HEAD/GET but doesn't pull any blobs yet.
	rootDesc, err := repo.Resolve(ctx, repo.Reference.Reference)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", ref, err)
	}
	manifestDesc, err := resolveManifestStreaming(ctx, repo, rootDesc)
	if err != nil {
		return fmt.Errorf("resolve manifest: %w", err)
	}
	mrc, err := repo.Fetch(ctx, manifestDesc)
	if err != nil {
		return fmt.Errorf("fetch manifest: %w", err)
	}
	manifestBytes, err := io.ReadAll(mrc)
	_ = mrc.Close()
	if err != nil {
		return err
	}
	var manifest v1.Manifest
	if err := unmarshalManifest(manifestBytes, &manifest); err != nil {
		return err
	}
	if len(manifest.Layers) == 0 {
		return fmt.Errorf("manifest %s has no layers", manifestDesc.Digest)
	}
	for i, layer := range manifest.Layers {
		if layer.Size == 0 {
			continue
		}
		brc, err := repo.Fetch(ctx, layer)
		if err != nil {
			return fmt.Errorf("fetch layer %d/%d %s: %w", i+1, len(manifest.Layers), layer.Digest, err)
		}
		err = extractLayer(brc, rootfsDir, layer.MediaType)
		_ = brc.Close()
		if err != nil {
			return fmt.Errorf("extract layer %d/%d %s: %w", i+1, len(manifest.Layers), layer.Digest, err)
		}
	}
	return nil
}
