// Package email delivers user-facing notifications over SMTP.
//
// Two scenarios drive a send today (see the API hook points in
// internal/server) :
//
//   - a user is @-mentioned in a chat / comment payload
//   - a new comment lands on a project the recipient shares
//
// The package itself is intentionally hook-agnostic — it just
// exposes a Sender contract that the API layer calls with the
// already-resolved recipient list + rendered body. Mention parsing,
// project membership lookup and idempotency live in the call sites.
//
// Runtime configuration is environment-only and read once at startup
// (see internal/server/api_settings_email.go for the read-only
// admin summary endpoint). Swapping SMTP creds requires a restart ;
// that's a deliberate constraint — there is no hot-reload code path
// and no plan for one. Operators set :
//
//	WEFT_LOOM_SMTP_HOST   e.g. smtp.example.org
//	WEFT_LOOM_SMTP_PORT   default 587
//	WEFT_LOOM_SMTP_USER   PLAIN auth username (typically the From)
//	WEFT_LOOM_SMTP_PASS   PLAIN auth password
//	WEFT_LOOM_SMTP_FROM   envelope + From: header
//
// When SMTPHost is empty NewSender returns a NoopSender that logs the
// intended delivery to the configured slog logger and returns nil ;
// this keeps the call sites free of "if mailer != nil" branches and
// makes "what would have been sent" easy to read in dev.
//
// Pure-Go : the SMTP path uses net/smtp from the standard library
// with PLAIN auth ; no third-party SMTP client. HTML bodies are
// supported via the Options-less Send signature : pass body that
// starts with "<" (after trimming) and we emit Content-Type:
// text/html ; otherwise text/plain. Both shapes set the standard
// MIME-Version + Date + Message-ID headers so well-behaved MTAs
// don't tag the message as suspicious.
package email

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/smtp"
	"os"
	"strings"
	"time"
)

// Options bundles the SMTP parameters. The zero value (SMTPHost
// empty) selects the NoopSender path.
type Options struct {
	// SMTPHost is the relay's hostname. Empty disables outbound mail.
	SMTPHost string
	// SMTPPort is the TCP port (typically 587 for STARTTLS submission
	// or 25 for plain). Defaults to 587 when zero and SMTPHost is set.
	SMTPPort int
	// Username is the PLAIN auth identity ; usually identical to From.
	Username string
	// Password is the PLAIN auth secret. Never logged.
	Password string
	// From is the envelope sender + the From: header value.
	From string
}

// Sender is the contract the API handlers depend on. Send is allowed
// to block for the duration of an SMTP dialogue ; callers either
// goroutine the call or accept the latency budget (single-recipient
// transactional mail is typically < 500 ms against a nearby relay).
type Sender interface {
	Send(ctx context.Context, to []string, subject, body string) error
}

// NewSender wires the appropriate Sender from Options. Empty
// SMTPHost selects the NoopSender ; otherwise the SMTPSender.
//
// log may be nil — both implementations no-op the logging when it is,
// which keeps the test surface tiny.
func NewSender(o Options, log *slog.Logger) Sender {
	if strings.TrimSpace(o.SMTPHost) == "" {
		return &NoopSender{log: log}
	}
	port := o.SMTPPort
	if port == 0 {
		port = 587
	}
	return &SMTPSender{
		addr:     fmt.Sprintf("%s:%d", o.SMTPHost, port),
		host:     o.SMTPHost,
		username: o.Username,
		password: o.Password,
		from:     o.From,
		log:      log,
	}
}

// NoopSender swallows the delivery. It exists so callers don't have
// to nil-check the Sender on every call site ; the log line is the
// dev-mode signal that "we would have sent something here".
type NoopSender struct {
	log *slog.Logger
}

// Send logs the intended delivery and returns nil. Never errors.
func (n *NoopSender) Send(_ context.Context, to []string, subject, _ string) error {
	if n.log != nil {
		n.log.Info("email: SMTP not configured ; skipping delivery",
			"to", to,
			"subject", subject)
	}
	return nil
}

// SMTPSender uses net/smtp's stdlib client. PLAIN auth ; STARTTLS is
// negotiated automatically by net/smtp when the server advertises it
// over the standard submission port.
type SMTPSender struct {
	addr     string // host:port
	host     string // host alone, for SMTP auth realm
	username string
	password string
	from     string
	log      *slog.Logger
}

// Send dispatches one message to every address in `to`. The body is
// rendered as text/html when it begins with "<" (after trimming) ;
// otherwise text/plain.
//
// Errors from net/smtp are wrapped with a "email send: " prefix so
// the call site logs surface the SMTP context — net/smtp's raw error
// strings (e.g. "wsa connect failed") aren't great in isolation.
//
// ctx is honoured only on the "should we even try" check (cancelled
// → return ctx.Err()). The SMTP dialogue itself runs net/smtp's
// blocking code path ; tightening that to ctx requires a custom
// dialer + Client that's out of scope for the initial wiring.
func (s *SMTPSender) Send(ctx context.Context, to []string, subject, body string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("email send: %w", err)
	}
	if len(to) == 0 {
		return nil
	}
	msg := buildMessage(s.from, to, subject, body)
	var auth smtp.Auth
	if s.username != "" {
		auth = smtp.PlainAuth("", s.username, s.password, s.host)
	}
	if err := smtp.SendMail(s.addr, auth, s.from, to, msg); err != nil {
		return fmt.Errorf("email send to %v via %s: %w", to, s.addr, err)
	}
	if s.log != nil {
		s.log.Info("email: delivered",
			"to", to,
			"subject", subject,
			"relay", s.addr)
	}
	return nil
}

// buildMessage assembles the RFC 5322 wire bytes : headers + blank
// line + body. text/html when the body looks like HTML, text/plain
// otherwise.
//
// Exposed for testing only ; not part of the package API.
func buildMessage(from string, to []string, subject, body string) []byte {
	contentType := "text/plain; charset=\"utf-8\""
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "<") {
		contentType = "text/html; charset=\"utf-8\""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(to, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Message-ID: <%s@%s>\r\n", randomID(), messageIDDomain(from))
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&b, "Content-Type: %s\r\n", contentType)
	fmt.Fprintf(&b, "Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return []byte(b.String())
}

func randomID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// Highly unlikely (crypto/rand falls back on /dev/urandom) ;
		// degrade to a timestamp so the field is still populated.
		return fmt.Sprintf("ts%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw[:])
}

func messageIDDomain(from string) string {
	if at := strings.LastIndexByte(from, '@'); at >= 0 && at < len(from)-1 {
		// Strip a trailing ">" if the From was an RFC 5322 angle-addr.
		dom := from[at+1:]
		dom = strings.TrimSuffix(dom, ">")
		return dom
	}
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "weft-loom.local"
}
