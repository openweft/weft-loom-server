package toolshare

// index.go — resolve an OCI manifest descriptor down to a concrete
// per-arch manifest. When the root descriptor is an OCI image index
// (manifest list) we walk its manifests, pick the linux/arm64 or
// amd64 entry (whichever runtime arch the loom-server is running on),
// and re-fetch that child manifest from the cache.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"runtime"

	v1 "github.com/opencontainers/image-spec/specs-go/v1"
	"oras.land/oras-go/v2/registry/remote"
)

const (
	mediaTypeOCIIndex          = "application/vnd.oci.image.index.v1+json"
	mediaTypeDockerManifestList = "application/vnd.docker.distribution.manifest.list.v2+json"
)

// resolveManifestStreaming looks at the root descriptor's mediaType ;
// if it's an index, fetches the index body from the registry, picks
// the right child + returns its descriptor. Otherwise returns the
// root unchanged (it's already a manifest). Streaming variant : no
// memory store, fetches directly from the repo.
func resolveManifestStreaming(ctx context.Context, repo *remote.Repository, root v1.Descriptor) (v1.Descriptor, error) {
	if root.MediaType != mediaTypeOCIIndex && root.MediaType != mediaTypeDockerManifestList {
		return root, nil
	}
	rc, err := repo.Fetch(ctx, root)
	if err != nil {
		return root, err
	}
	body, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		return root, err
	}
	var idx struct {
		Manifests []v1.Descriptor `json:"manifests"`
	}
	if err := json.Unmarshal(body, &idx); err != nil {
		return root, err
	}
	// Only accept the host arch — the workspace VM is the SAME
	// arch as the loom-server (TCG emulates aarch64 on aarch64 host
	// in dev, prod VMs match the host arch). Falling back to a
	// different arch would produce a rootfs with binaries the guest
	// can't execute (silent failure : tool wrappers return
	// `Exec format error` only when the user invokes them).
	for _, m := range idx.Manifests {
		if m.Platform == nil {
			continue
		}
		if m.Platform.OS == "linux" && m.Platform.Architecture == runtime.GOARCH {
			return m, nil
		}
	}
	return root, fmt.Errorf("no linux/%s manifest in index (%d entries) — image doesn't ship for this arch", runtime.GOARCH, len(idx.Manifests))
}
