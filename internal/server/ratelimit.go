// Package server — ratelimit.go : per-key token-bucket rate limiter
// for the public + abuse-prone endpoints.
//
// Today three endpoint families are gated :
//
//   - /public/{token}/files[/{path...}]              publicLimiter (per-IP)
//   - /api/projects/{name}/notify-mention            notifyLimiter (per-identity)
//   - /api/arxiv/search,
//     /api/projects/{name}/bib/from-doi,
//     /api/projects/{name}/zotero/sync               externalProxyLimiter (per-identity)
//
// The other surfaces (LSP WS, sync WS, file PUT/GET) have their own
// backpressure (WS frame ordering, per-project locks) so we don't
// blanket-limit them — that would just degrade the editor UX without
// changing the attack surface.
//
// Limits are token-buckets : `RatePerMinute` refills smoothly, with
// a small burst tolerance (= rate, so a fresh bucket spans one full
// minute of headroom). On exceed we return 429 + Retry-After in
// seconds (rounded up).
//
// Per-key isolation : every (policy, key) tuple has its own bucket.
// Keys are remote IP for unauthenticated paths and the authenticated
// subject otherwise. A nil identity on an authed path falls back to
// the remote IP — keeps the limiter loud even when the auth layer
// is in dev mode.
//
// Env knobs (defaults shown) :
//
//	WEFT_LOOM_RATELIMIT_PUBLIC_PER_MIN          60
//	WEFT_LOOM_RATELIMIT_NOTIFY_PER_MIN          10
//	WEFT_LOOM_RATELIMIT_EXTERNAL_PROXY_PER_MIN  30
//
// Setting any of them to 0 disables the corresponding limiter (the
// middleware becomes a pass-through). Negative values are treated as
// 0 ; non-numeric strings fall through to the default.
//
// Implementation : standard library only (`sync`, `time`, `net/http`).
// `golang.org/x/time/rate` IS in the module's go.sum (indirect dep
// via go-git), but pulling it in as a direct import is overkill for
// the three buckets we need and locks the module to a heavier
// dependency boundary. The 50-line bucket below is enough.

package server

import (
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
)

// rateLimitPolicyName is a stable string identifier for each policy
// (used both as the metric label and as the map key dimension so two
// policies that happen to share a key don't accidentally cross-fund
// each other's bucket).
type rateLimitPolicyName string

const (
	policyPublic        rateLimitPolicyName = "public"
	policyNotify        rateLimitPolicyName = "notify"
	policyExternalProxy rateLimitPolicyName = "external_proxy"
)

// Defaults aimed at production : strict enough to make spam
// uneconomical, loose enough that real users editing a paper never
// notice the limiter exists.
const (
	defaultPublicPerMin        = 60
	defaultNotifyPerMin        = 10
	defaultExternalProxyPerMin = 30
)

// rateLimiter is a fixed-bucket per-key token bucket. Tokens refill
// continuously at `ratePerSec` ; the bucket caps at `burst` tokens.
// Concurrent access is guarded by a single mutex per limiter — the
// per-bucket critical section is two arithmetic ops + a map lookup,
// so contention is negligible even under 10 kRPS.
type rateLimiter struct {
	name       rateLimitPolicyName
	ratePerSec float64
	burst      float64

	now func() time.Time // injectable clock for tests

	mu      sync.Mutex
	buckets map[string]*tokenBucket
}

// tokenBucket holds the per-key state. `tokens` is the current
// available count (float so partial refills carry across calls) ;
// `last` is the timestamp of the most recent refill.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

// newRateLimiter builds a limiter with `perMin` requests per minute
// and a burst equal to `perMin` (one minute of headroom). A perMin
// <= 0 disables the limiter — the allow() fast-path returns true
// without touching the map.
func newRateLimiter(name rateLimitPolicyName, perMin int) *rateLimiter {
	if perMin < 0 {
		perMin = 0
	}
	return &rateLimiter{
		name:       name,
		ratePerSec: float64(perMin) / 60.0,
		burst:      float64(perMin),
		now:        time.Now,
		buckets:    make(map[string]*tokenBucket),
	}
}

// enabled reports whether the limiter has a non-zero rate (i.e. is
// configured to actually limit something). A disabled limiter still
// implements the same surface so callers don't need to nil-check.
func (rl *rateLimiter) enabled() bool {
	return rl != nil && rl.ratePerSec > 0
}

// allow consumes one token for `key`. Returns (ok, retryAfter) where
// retryAfter is the wall-clock duration the caller should wait before
// the next request would succeed (zero when ok=true).
func (rl *rateLimiter) allow(key string) (bool, time.Duration) {
	if !rl.enabled() {
		return true, 0
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := rl.now()
	b, ok := rl.buckets[key]
	if !ok {
		// First sighting : full bucket minus the one token we're
		// about to consume.
		rl.buckets[key] = &tokenBucket{tokens: rl.burst - 1, last: now}
		return true, 0
	}
	// Refill : carry tokens forward from `last`, cap at burst.
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * rl.ratePerSec
		if b.tokens > rl.burst {
			b.tokens = rl.burst
		}
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	// Deny : compute the minimal wait for the bucket to recover one
	// token, rounded up to the nearest second so Retry-After matches
	// the HTTP wire format expectations (integer seconds).
	missing := 1 - b.tokens
	waitSec := missing / rl.ratePerSec
	d := time.Duration(waitSec*float64(time.Second)) + time.Millisecond // ceil to avoid 0s
	return false, d
}

// rateLimitConfig snapshots the operator-tunable knobs at server
// construction. Fields are integers (requests per minute) ; zero =
// limiter disabled for that policy.
type rateLimitConfig struct {
	publicPerMin        int
	notifyPerMin        int
	externalProxyPerMin int
}

// loadRateLimitConfig reads the three env vars + falls back to the
// production defaults. Invalid values (non-numeric, negative) fall
// through to the default — we don't want a typo'd env to silently
// disable the limiter in production.
func loadRateLimitConfig() rateLimitConfig {
	return rateLimitConfig{
		publicPerMin:        envIntDefault("WEFT_LOOM_RATELIMIT_PUBLIC_PER_MIN", defaultPublicPerMin),
		notifyPerMin:        envIntDefault("WEFT_LOOM_RATELIMIT_NOTIFY_PER_MIN", defaultNotifyPerMin),
		externalProxyPerMin: envIntDefault("WEFT_LOOM_RATELIMIT_EXTERNAL_PROXY_PER_MIN", defaultExternalProxyPerMin),
	}
}

// envIntDefault parses an integer env var. Empty/unset/invalid →
// the supplied default. Explicit "0" passes through (disables the
// limiter). Negative values clamp to 0.
func envIntDefault(name string, def int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	if n < 0 {
		return 0
	}
	return n
}

// ensureRateLimiters builds the three limiters lazily on first use.
// Stored on the Server so a re-entry of routes() (test fixture path)
// reuses the same buckets. Safe to call repeatedly.
func (s *Server) ensureRateLimiters() {
	s.ratelimitOnce.Do(func() {
		cfg := loadRateLimitConfig()
		s.publicLimiter = newRateLimiter(policyPublic, cfg.publicPerMin)
		s.notifyLimiter = newRateLimiter(policyNotify, cfg.notifyPerMin)
		s.externalProxyLimiter = newRateLimiter(policyExternalProxy, cfg.externalProxyPerMin)
	})
}

// rateLimit wraps an http.HandlerFunc so each request is metered
// against the supplied limiter. Key extraction depends on the policy :
// publicLimiter keys on remote IP (no identity), the others fall back
// to remote IP only if the auth layer didn't inject an identity.
func (s *Server) rateLimit(rl *rateLimiter, h http.HandlerFunc) http.HandlerFunc {
	if !rl.enabled() {
		return h
	}
	return func(w http.ResponseWriter, r *http.Request) {
		key := s.rateLimitKey(rl, r)
		ok, retry := rl.allow(key)
		if !ok {
			retrySec := int(retry.Seconds())
			if retrySec < 1 {
				retrySec = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(retrySec))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

// rateLimitKey computes the per-bucket key. Public traffic ignores
// the identity (there isn't one) ; authed traffic prefers the subject
// because we want a per-user quota even when many users share an
// egress IP (corp NAT, university campus).
func (s *Server) rateLimitKey(rl *rateLimiter, r *http.Request) string {
	if rl.name != policyPublic {
		if ident, ok := auth.IdentityFrom(r.Context()); ok && ident.Subject != "" {
			return "sub:" + ident.Subject
		}
	}
	return "ip:" + remoteIP(r)
}

// remoteIP extracts the client IP. Honours X-Forwarded-For when set
// (we sit behind a reverse proxy in production) and falls back to
// the TCP peer otherwise. The first XFF entry wins — that's the
// originating client, downstream proxies append themselves to the
// right.
func remoteIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// First comma-separated entry.
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// humaRateLimit returns a huma middleware that meters the operation
// against `rl`. Mirrors rateLimit() but uses huma.Context so the
// 429 response goes through huma's transform pipeline (and the
// per-op middleware chain configured via huma.Operation.Middlewares).
func (s *Server) humaRateLimit(rl *rateLimiter) func(ctx huma.Context, next func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if !rl.enabled() {
			next(ctx)
			return
		}
		key := s.humaRateLimitKey(rl, ctx)
		ok, retry := rl.allow(key)
		if !ok {
			retrySec := int(retry.Seconds())
			if retrySec < 1 {
				retrySec = 1
			}
			ctx.SetHeader("Retry-After", strconv.Itoa(retrySec))
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusTooManyRequests)
			_, _ = ctx.BodyWriter().Write([]byte(`{"error":"rate limit exceeded"}`))
			return
		}
		next(ctx)
	}
}

// humaRateLimitKey mirrors rateLimitKey for the huma context surface.
// huma.Context only exposes RemoteAddr() + Context() ; the identity
// is still in ctx.Context() because ServeHTTP runs before huma.
func (s *Server) humaRateLimitKey(rl *rateLimiter, ctx huma.Context) string {
	if rl.name != policyPublic {
		if ident, ok := auth.IdentityFrom(ctx.Context()); ok && ident.Subject != "" {
			return "sub:" + ident.Subject
		}
	}
	addr := ctx.RemoteAddr()
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return "ip:" + host
	}
	return "ip:" + addr
}
