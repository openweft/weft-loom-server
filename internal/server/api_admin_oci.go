package server

// api_admin_oci.go — operator-facing endpoint that surfaces the
// status of every OCI image the compile dispatcher expects.
//
//   GET /api/admin/oci-images
//
// Returns one entry per language with :
//   - language
//   - image ref (resolved through WEFT_LOOM_IMAGE_<LANG> override)
//   - status   : "ok" | "missing" | "unauthorized" | "unreachable"
//   - last_checked_unix
//
// Probes use an HTTP GET against the OCI Distribution v2 manifest
// endpoint (`/v2/<repo>/manifests/<tag>`) with the standard manifest
// Accept header. Public images on ghcr.io require a one-shot token
// fetch from `ghcr.io/token` ; we follow that flow lazily.
//
// Results are cached for 5 minutes so the operator can refresh the
// admin panel without hammering the registry.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ociImagesInput models the optional ?force=1 query string. huma maps
// the query into a bool ; "1"/"true" both flip it on.
type ociImagesInput struct {
	Force bool `query:"force" doc:"Force a fresh probe (bypass the 5-minute cache)"`
}

// ociImagesOutput wraps { "images": [...] } so the wire is
// byte-identical to the legacy raw handler.
type ociImagesOutput struct {
	Body struct {
		Images []ociImageStatus `json:"images"`
	}
}

// Languages whose compile path maps to an OCI image. Kept in sync
// with internal/compile/microvm.go:imageForLanguage().
var ociLanguages = []string{"latex", "markdown", "golang", "python", "rust", "node", "cpp"}

func imageRefForOCI(language string) string {
	envOverride := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return def
	}
	switch language {
	case "latex":
		return envOverride("WEFT_LOOM_IMAGE_LATEX", "ghcr.io/openweft/weft-loom-texlive:latest")
	case "markdown":
		return envOverride("WEFT_LOOM_IMAGE_MARKDOWN", "ghcr.io/openweft/weft-loom-markdown:latest")
	case "golang":
		return envOverride("WEFT_LOOM_IMAGE_GOLANG", "ghcr.io/openweft/weft-loom-golang:latest")
	case "python":
		return envOverride("WEFT_LOOM_IMAGE_PYTHON", "ghcr.io/openweft/weft-loom-python:latest")
	case "rust":
		return envOverride("WEFT_LOOM_IMAGE_RUST", "ghcr.io/openweft/weft-loom-rust:latest")
	case "node":
		return envOverride("WEFT_LOOM_IMAGE_NODE", "ghcr.io/openweft/weft-loom-node:latest")
	case "cpp":
		return envOverride("WEFT_LOOM_IMAGE_CPP", "ghcr.io/openweft/weft-loom-cpp:latest")
	}
	return ""
}

type ociImageStatus struct {
	Language        string `json:"language"`
	Image           string `json:"image"`
	Status          string `json:"status"`
	LastCheckedUnix int64  `json:"last_checked_unix"`
	Detail          string `json:"detail,omitempty"`
}

type ociProber struct {
	mu      sync.Mutex
	cache   map[string]ociImageStatus
	lastRun time.Time
}

func newOCIProber() *ociProber { return &ociProber{cache: map[string]ociImageStatus{}} }

const ociProbeTTL = 5 * time.Minute

func (p *ociProber) snapshot(ctx context.Context, force bool) []ociImageStatus {
	p.mu.Lock()
	stale := force || time.Since(p.lastRun) > ociProbeTTL || len(p.cache) == 0
	p.mu.Unlock()
	if stale {
		p.refresh(ctx)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]ociImageStatus, 0, len(p.cache))
	for _, lang := range ociLanguages {
		if e, ok := p.cache[lang]; ok {
			out = append(out, e)
		}
	}
	return out
}

func (p *ociProber) refresh(ctx context.Context) {
	now := time.Now().Unix()
	results := make(map[string]ociImageStatus, len(ociLanguages))
	var wg sync.WaitGroup
	var resultsMu sync.Mutex
	for _, lang := range ociLanguages {
		lang := lang
		ref := imageRefForOCI(lang)
		if ref == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, detail := probeOCIImage(ctx, ref)
			resultsMu.Lock()
			results[lang] = ociImageStatus{
				Language:        lang,
				Image:           ref,
				Status:          status,
				LastCheckedUnix: now,
				Detail:          detail,
			}
			resultsMu.Unlock()
		}()
	}
	wg.Wait()
	p.mu.Lock()
	p.cache = results
	p.lastRun = time.Now()
	p.mu.Unlock()
}

// probeOCIImage parses an image ref `<registry>/<repo>:<tag>` and
// probes its manifest. Returns ("ok", "") on success, otherwise a
// status string + a short human-readable detail.
func probeOCIImage(ctx context.Context, ref string) (string, string) {
	registry, repo, tag := parseImageRef(ref)
	if registry == "" {
		return "unreachable", "could not parse image ref"
	}
	// For public ghcr.io images, the manifest endpoint requires a
	// short-lived token fetched from ghcr.io/token. The protocol :
	//   1) GET https://ghcr.io/v2/<repo>/manifests/<tag>
	//        → 401 + WWW-Authenticate: Bearer realm="..." scope="..."
	//   2) GET <realm>?service=...&scope=...
	//        → { "token": "..." }
	//   3) Retry GET <manifests> with `Authorization: Bearer <token>`
	// We accept either 200 (image exists) or 401 without token (the
	// image is private — counts as "unauthorized" to the operator).
	manifestURL := "https://" + registry + "/v2/" + repo + "/manifests/" + tag
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
	req.Header.Set("Accept", "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json")
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "unreachable", err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return "ok", ""
	}
	if resp.StatusCode == http.StatusUnauthorized {
		// Try the anonymous token dance for ghcr.io public images.
		token := fetchGHCRToken(ctx, repo)
		if token != "" {
			req2, _ := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
			req2.Header = req.Header.Clone()
			req2.Header.Set("Authorization", "Bearer "+token)
			resp2, err2 := client.Do(req2)
			if err2 == nil {
				defer resp2.Body.Close()
				if resp2.StatusCode == http.StatusOK {
					return "ok", ""
				}
				if resp2.StatusCode == http.StatusNotFound {
					return "missing", "manifest not found at " + tag
				}
				return "unauthorized", "HTTP " + resp2.Status
			}
		}
		return "unauthorized", "401 ; private or token flow failed"
	}
	if resp.StatusCode == http.StatusNotFound {
		return "missing", "manifest not found at " + tag
	}
	return "unreachable", "HTTP " + resp.Status
}

func fetchGHCRToken(ctx context.Context, repo string) string {
	u := "https://ghcr.io/token?service=ghcr.io&scope=repository:" + repo + ":pull"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, _ := io.ReadAll(resp.Body)
	var out struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(body, &out) != nil {
		return ""
	}
	return out.Token
}

// parseImageRef splits `registry/repo:tag` into its three parts.
// Defaults the tag to "latest" when omitted.
func parseImageRef(ref string) (registry, repo, tag string) {
	slash := strings.IndexByte(ref, '/')
	if slash < 0 {
		return "", "", ""
	}
	registry = ref[:slash]
	rest := ref[slash+1:]
	tag = "latest"
	if colon := strings.LastIndexByte(rest, ':'); colon >= 0 {
		repo = rest[:colon]
		tag = rest[colon+1:]
	} else {
		repo = rest
	}
	return
}

