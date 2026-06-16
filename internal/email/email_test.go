package email

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
)

// TestNewSender_EmptyHost — empty SMTPHost selects the NoopSender,
// and Send returns nil without panicking even with a nil logger.
func TestNewSender_EmptyHost(t *testing.T) {
	s := NewSender(Options{}, nil)
	if _, ok := s.(*NoopSender); !ok {
		t.Fatalf("expected NoopSender, got %T", s)
	}
	if err := s.Send(context.Background(), []string{"a@b"}, "hi", "body"); err != nil {
		t.Fatalf("noop send returned err: %v", err)
	}
	// Whitespace-only host also flips to noop.
	s2 := NewSender(Options{SMTPHost: "   "}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, ok := s2.(*NoopSender); !ok {
		t.Fatalf("expected NoopSender for whitespace host, got %T", s2)
	}
}

// TestNewSender_RealHostPicksSMTP — non-empty SMTPHost selects the
// real SMTPSender and defaults port 587 when zero.
func TestNewSender_RealHostPicksSMTP(t *testing.T) {
	s := NewSender(Options{SMTPHost: "smtp.example.org"}, nil)
	got, ok := s.(*SMTPSender)
	if !ok {
		t.Fatalf("expected SMTPSender, got %T", s)
	}
	if got.addr != "smtp.example.org:587" {
		t.Fatalf("expected default port 587 in addr ; got %q", got.addr)
	}
	s2 := NewSender(Options{SMTPHost: "smtp.example.org", SMTPPort: 2525}, nil)
	if s2.(*SMTPSender).addr != "smtp.example.org:2525" {
		t.Fatalf("expected explicit port to carry through ; got %q", s2.(*SMTPSender).addr)
	}
}

// TestSMTPSender_ContextCancelled — a cancelled ctx short-circuits
// before we dial.
func TestSMTPSender_ContextCancelled(t *testing.T) {
	s := NewSender(Options{SMTPHost: "smtp.example.org", From: "x@example.org"}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := s.Send(ctx, []string{"a@b"}, "subj", "body")
	if err == nil {
		t.Fatalf("expected ctx err, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected ctx.Canceled wrapped ; got %v", err)
	}
	if !strings.Contains(err.Error(), "email send") {
		t.Fatalf("expected wrap prefix ; got %v", err)
	}
}

// TestSMTPSender_EmptyRecipients — no recipients = no-op, no dial.
func TestSMTPSender_EmptyRecipients(t *testing.T) {
	s := NewSender(Options{SMTPHost: "smtp.example.org", From: "x@example.org"}, nil)
	if err := s.Send(context.Background(), nil, "subj", "body"); err != nil {
		t.Fatalf("empty recipients should be a no-op ; got %v", err)
	}
}

// TestSMTPSender_DialFailureWrapped — pointing at a closed loopback
// port surfaces a wrapped net/smtp error that still mentions the
// relay address (so log lines aren't decontextualised).
func TestSMTPSender_DialFailureWrapped(t *testing.T) {
	// Grab a port that is guaranteed closed by listening + closing
	// before the send. Race-free : SO_REUSEADDR is irrelevant since
	// we're targeting refused-connect.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := l.Addr().(*net.TCPAddr)
	_ = l.Close()

	s := &SMTPSender{
		addr: addr.String(),
		host: "127.0.0.1",
		from: "x@example.org",
	}
	err = s.Send(context.Background(), []string{"a@b"}, "subj", "body")
	if err == nil {
		t.Fatalf("expected dial failure, got nil")
	}
	if !strings.Contains(err.Error(), "email send to") {
		t.Fatalf("error should be wrapped with email send to ; got %q", err.Error())
	}
	if !strings.Contains(err.Error(), addr.String()) {
		t.Fatalf("error should mention the relay addr %q ; got %q", addr.String(), err.Error())
	}
}

// TestBuildMessage_HTMLDetection — body starting with "<" picks
// text/html ; otherwise text/plain. Headers carry the standard MIME
// + Message-ID shape.
func TestBuildMessage_HTMLDetection(t *testing.T) {
	plain := string(buildMessage("from@example.org", []string{"to@example.org"}, "subj", "hello world"))
	if !strings.Contains(plain, "Content-Type: text/plain") {
		t.Fatalf("plain body should produce text/plain ; got\n%s", plain)
	}
	if !strings.Contains(plain, "Subject: subj") {
		t.Fatalf("missing subject ; got\n%s", plain)
	}
	if !strings.Contains(plain, "From: from@example.org") {
		t.Fatalf("missing from ; got\n%s", plain)
	}
	if !strings.Contains(plain, "Message-ID: <") {
		t.Fatalf("missing Message-ID ; got\n%s", plain)
	}
	if !strings.HasSuffix(strings.SplitN(plain, "\r\n\r\n", 2)[1], "hello world") {
		t.Fatalf("body should be after blank line ; got\n%s", plain)
	}

	html := string(buildMessage("from@example.org", []string{"to@example.org"}, "subj", "  <p>hello</p>"))
	if !strings.Contains(html, "Content-Type: text/html") {
		t.Fatalf("html-shaped body should produce text/html ; got\n%s", html)
	}
}

// TestMessageIDDomain_Fallbacks — explicit from domain wins ; bare
// names fall back to hostname or the constant.
func TestMessageIDDomain_Fallbacks(t *testing.T) {
	if got := messageIDDomain("alice@bob.example"); got != "bob.example" {
		t.Fatalf("expected bob.example ; got %q", got)
	}
	if got := messageIDDomain("Alice <alice@bob.example>"); got != "bob.example" {
		t.Fatalf("expected angle-addr strip ; got %q", got)
	}
	if got := messageIDDomain("noatsign"); got == "" {
		t.Fatalf("expected non-empty fallback ; got empty")
	}
}
