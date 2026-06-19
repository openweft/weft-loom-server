package server

// ratelimit_test.go — table-driven coverage for the token-bucket
// rate limiter wired into the public + abuse-prone endpoints.
//
// The tests pin a tiny `3 req/min` policy so a "burst of 4" exhausts
// the bucket deterministically without sleeping for real wall-clock
// time. Refill recovery is exercised through the injectable clock
// (`rl.now`) so the suite stays sub-millisecond.

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// newTestLimiter builds a limiter with a controllable clock so tests
// don't sleep ; they advance the clock through the returned setter.
func newTestLimiter(t *testing.T, perMin int) (*rateLimiter, func(time.Duration)) {
	t.Helper()
	rl := newRateLimiter("test", perMin)
	now := time.Unix(1_700_000_000, 0)
	rl.now = func() time.Time { return now }
	advance := func(d time.Duration) { now = now.Add(d) }
	return rl, advance
}

func TestRateLimit_BurstThenDeny(t *testing.T) {
	rl, _ := newTestLimiter(t, 3)
	srv := &Server{publicLimiter: rl}
	handler := srv.rateLimit(rl, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	const ip = "10.0.0.1:55555"
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d : want 200, got %d (body=%q)", i+1, rec.Code, rec.Body.String())
		}
	}
	// 4th request : bucket empty, expect 429.
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = ip
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4th request : want 429, got %d", rec.Code)
	}
}

func TestRateLimit_RetryAfterHeader(t *testing.T) {
	rl, _ := newTestLimiter(t, 3)
	srv := &Server{publicLimiter: rl}
	handler := srv.rateLimit(rl, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	const ip = "10.0.0.2:55555"
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = ip
		handler(httptest.NewRecorder(), req)
	}
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = ip
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rec.Code)
	}
	retry := rec.Header().Get("Retry-After")
	if retry == "" {
		t.Fatal("Retry-After header missing on 429 response")
	}
	n, err := strconv.Atoi(retry)
	if err != nil {
		t.Fatalf("Retry-After not numeric : %q (%v)", retry, err)
	}
	// At 3 req/min the refill rate is 1 token per 20s ; ceiling
	// guarantees Retry-After >= 1.
	if n < 1 {
		t.Fatalf("Retry-After must be >= 1s, got %d", n)
	}
	if n > 60 {
		t.Fatalf("Retry-After must be <= 60s for a 3/min limiter, got %d", n)
	}
}

func TestRateLimit_PerIPIsolation(t *testing.T) {
	rl, _ := newTestLimiter(t, 3)
	srv := &Server{publicLimiter: rl}
	handler := srv.rateLimit(rl, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// IP A : exhaust the quota.
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "10.0.0.10:1111"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("A req %d : want 200, got %d", i+1, rec.Code)
		}
	}
	// IP A : 4th denied.
	{
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "10.0.0.10:1111"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("A 4th : want 429, got %d", rec.Code)
		}
	}
	// IP B : full quota still available — independent bucket.
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "10.0.0.20:2222"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("B req %d : want 200, got %d", i+1, rec.Code)
		}
	}
}

func TestRateLimit_TimeBasedRecovery(t *testing.T) {
	// 3 req/min → refill = 1 token per 20s. Advance the injected
	// clock by 30s after exhausting the bucket and the next request
	// must succeed.
	rl, advance := newTestLimiter(t, 3)
	srv := &Server{publicLimiter: rl}
	handler := srv.rateLimit(rl, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	const ip = "10.0.0.30:3333"
	// Drain.
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("drain %d : want 200, got %d", i+1, rec.Code)
		}
	}
	// Denied immediately after drain.
	{
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = ip
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("post-drain : want 429, got %d", rec.Code)
		}
	}
	// Wait past the 20s refill boundary.
	advance(30 * time.Second)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = ip
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("post-recovery : want 200 (bucket should have refilled), got %d (Retry-After=%q)", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestRateLimit_DisabledPolicyIsPassThrough(t *testing.T) {
	// perMin == 0 → enabled() returns false → middleware is a
	// transparent pass-through (no header writes, no 429s).
	rl := newRateLimiter("disabled", 0)
	srv := &Server{}
	handler := srv.rateLimit(rl, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	for i := 0; i < 100; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "10.0.0.40:4444"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("disabled limiter must pass-through, got %d at iter %d", rec.Code, i)
		}
	}
}

func TestRateLimit_XForwardedForHonoured(t *testing.T) {
	// Two requests from the SAME TCP peer but different XFF heads :
	// the limiter must isolate them (per-client quota even behind a
	// reverse proxy).
	rl, _ := newTestLimiter(t, 3)
	srv := &Server{publicLimiter: rl}
	handler := srv.rateLimit(rl, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "127.0.0.1:9999" // shared proxy peer
		req.Header.Set("X-Forwarded-For", "203.0.113.10")
		handler(httptest.NewRecorder(), req)
	}
	// Client A exhausted ; Client B (different XFF) still allowed.
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.20")
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("XFF isolation : second client must succeed, got %d", rec.Code)
	}
}

func TestRateLimit_EnvIntDefault(t *testing.T) {
	// envIntDefault rules : empty → default ; valid int → value ;
	// negative → 0 ; non-numeric → default. Asserted via t.Setenv so
	// the table isn't visible to siblings.
	cases := []struct {
		raw  string
		def  int
		want int
	}{
		{"", 42, 42},
		{"10", 42, 10},
		{"0", 42, 0},
		{"-5", 42, 0},
		{"not-a-number", 42, 42},
		{"  17  ", 42, 17},
	}
	for _, c := range cases {
		t.Setenv("WEFT_LOOM_RATELIMIT_TEST", c.raw)
		got := envIntDefault("WEFT_LOOM_RATELIMIT_TEST", c.def)
		if got != c.want {
			t.Errorf("envIntDefault(%q, %d) = %d ; want %d", c.raw, c.def, got, c.want)
		}
	}
}
