package server

// api_notify.go — server-side @-mention notification fan-out.
//
//   POST /api/projects/{name}/notify-mention
//
// Comments live in the Yjs CRDT (frontend-only), so the server never
// sees a "comment created" event directly. The SPA extracts the
// @-mentioned subjects from the new comment body and pings this
// endpoint after the local CRDT write succeeds — fire-and-forget so
// the comment UI never blocks on SMTP.
//
// Anti-spam : every recipient must be on the project's sharing.json.
// Else 403 — a malicious client can't use this endpoint to spam an
// arbitrary inbox. Pre-condition reuses the existing readSharing helper
// from api_sharing.go.
//
// Email resolution :
//   - request body MAY carry `recipient_emails` aligned 1:1 with
//     `recipients`. The SPA fills this from Awareness when available.
//   - else we treat the recipient subject as the email itself. In
//     dev mode dex subjects ARE the email (alice@example.com) so this
//     degrades cleanly ; in prod the SPA is expected to surface the
//     email via Awareness or a future identity lookup.
//
// Delivery is asynchronous : the SMTP dialogue runs in a goroutine
// with context.Background() so the HTTP response stays snappy + the
// commenter doesn't wait for the relay. Result is logged ; the user
// sees no UI feedback for delivery success/failure (V0.14 scope).

import (
	"context"
	"fmt"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/eventbus"
)

type notifyMentionInput struct {
	Project string `path:"name" doc:"Project name"`
	Body    struct {
		Recipients      []string `json:"recipients" doc:"Subjects (or display names matching sharing.json User entries) extracted from @-mentions in the comment body."`
		RecipientEmails []string `json:"recipient_emails,omitempty" doc:"Optional emails aligned 1:1 with recipients. When absent the subject itself is used as the email."`
		CommentExcerpt  string   `json:"comment_excerpt" doc:"First ~200 chars of the comment body for the email preview."`
		AuthorName      string   `json:"author_name" doc:"Display name of the commenter."`
		FilePath        string   `json:"file_path" doc:"Path of the file the comment was attached to."`
	}
}

type notifyMentionOutput struct {
	Status int
	Body   struct {
		Notified int `json:"notified" doc:"Number of recipient addresses the mailer was asked to deliver to."`
	}
}

func mountNotifyAPI(api huma.API, s *Server) {
	// Anti-spam : cap notify-mention to a small number of requests
	// per identity per minute. notify-mention is the only endpoint
	// that can spend SMTP money so it gets the strictest rate.
	var notifyMiddlewares huma.Middlewares
	if s != nil && s.notifyLimiter.enabled() {
		notifyMiddlewares = huma.Middlewares{s.humaRateLimit(s.notifyLimiter)}
	}
	huma.Register(api, huma.Operation{
		OperationID:   "notify-mention",
		Method:        "POST",
		Path:          "/api/projects/{name}/notify-mention",
		Summary:       "Email-notify users @-mentioned in a comment",
		Description:   "Fire-and-forget : enqueues an email to every recipient who is also on the project's sharing.json. Returns 202 immediately ; SMTP runs in a background goroutine. Recipients NOT on the ACL refuse the whole request with 403 (anti-spam guard).",
		Tags:          []string{"notify"},
		DefaultStatus: 202,
		Middlewares:   notifyMiddlewares,
	}, func(ctx context.Context, in *notifyMentionInput) (*notifyMentionOutput, error) {
		out := &notifyMentionOutput{Status: 202}
		if s == nil {
			return nil, huma.Error500InternalServerError("server not initialised")
		}
		ident, _ := auth.IdentityFrom(ctx)

		// De-dupe + trim recipients ; an empty list is a no-op 202.
		recipients := dedupTrim(in.Body.Recipients)
		if len(recipients) == 0 {
			return out, nil
		}

		// ACL guard : every recipient must be on sharing.json. Reuse
		// the existing helper so the storage path (LocalStore today,
		// PostgresStore tomorrow) stays single-source.
		doc, err := s.readSharing(ctx, ident, in.Project)
		if err != nil {
			return nil, huma.Error500InternalServerError("notify: sharing read", err)
		}
		shareSet := make(map[string]struct{}, len(doc.Shares))
		for _, sh := range doc.Shares {
			shareSet[strings.ToLower(strings.TrimSpace(sh.User))] = struct{}{}
		}
		// The project owner is also a legitimate recipient (typically
		// not on their own sharing.json). Read it best-effort ; a
		// missing owner file isn't a refusal trigger.
		if owner, oerr := s.ownerOf(ctx, ident, in.Project); oerr == nil && owner != "" {
			shareSet[strings.ToLower(owner)] = struct{}{}
		}
		for _, r := range recipients {
			if _, ok := shareSet[strings.ToLower(r)]; !ok {
				return nil, huma.Error403Forbidden(fmt.Sprintf("notify: recipient %q is not on the project ACL", r))
			}
		}

		// Resolve emails. The SPA may carry recipient_emails aligned
		// 1:1 with recipients ; when shorter we pad with the subject
		// itself (dev-mode subjects ARE the email).
		emails := make([]string, 0, len(recipients))
		for i, r := range recipients {
			if i < len(in.Body.RecipientEmails) {
				email := strings.TrimSpace(in.Body.RecipientEmails[i])
				if email != "" {
					emails = append(emails, email)
					continue
				}
			}
			emails = append(emails, r)
		}

		out.Body.Notified = len(emails)

		// Mailer defaults to NoopSender post-V0.14 wiring ; guard
		// against a nil only for the test path that constructs a
		// Server without going through cmd/weft-loom main.
		if s.opts.Mailer == nil {
			s.events.Publish(eventbus.Event{
				Source: "server", Component: "notify", Verb: "skip",
				Project: in.Project,
				Fields:  map[string]any{"reason": "mailer nil", "count": len(emails)},
			})
			return out, nil
		}

		subject := fmt.Sprintf("[weft-loom] You were mentioned in %s", in.Project)
		body := buildMentionBody(in.Body.AuthorName, in.Project, in.Body.FilePath, in.Body.CommentExcerpt)
		mailer := s.opts.Mailer
		log := s.opts.Logger
		// Fire-and-forget : context.Background so the SMTP dialogue
		// outlives the HTTP request. A real cancellation source would
		// be process shutdown ; that path is acceptable as a dropped
		// notification (mention emails are best-effort, not durable).
		go func(to []string) {
			if err := mailer.Send(context.Background(), to, subject, body); err != nil && log != nil {
				log.Warn("notify: mailer send failed", "err", err, "to", to, "project", in.Project)
			}
		}(emails)

		s.events.Publish(eventbus.Event{
			Source: "server", Component: "notify", Verb: "send",
			Project: in.Project,
			Fields:  map[string]any{"count": len(emails)},
		})

		return out, nil
	})
}

// dedupTrim normalises the recipient list : trim whitespace + drop
// empty entries + keep the first occurrence of each (case-preserving,
// case-insensitive comparison).
func dedupTrim(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		key := strings.ToLower(s)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, s)
	}
	return out
}

// buildMentionBody renders the plain-text body of the notification.
// Excerpt is truncated to 400 chars defensively — comment bodies can
// be arbitrarily long and we don't want to email a novel.
func buildMentionBody(author, project, file, excerpt string) string {
	if author == "" {
		author = "Someone"
	}
	if file == "" {
		file = "(unknown file)"
	}
	excerpt = strings.TrimSpace(excerpt)
	if len(excerpt) > 400 {
		excerpt = excerpt[:400] + "…"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s mentioned you in a comment on %s.\r\n\r\n", author, project)
	fmt.Fprintf(&b, "File : %s\r\n\r\n", file)
	if excerpt != "" {
		fmt.Fprintf(&b, "Excerpt :\r\n\r\n  %s\r\n\r\n", excerpt)
	}
	b.WriteString("Open weft-loom to reply.\r\n")
	return b.String()
}
