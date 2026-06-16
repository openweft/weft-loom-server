package server

// api_settings_email.go — read-only summary of the operator's SMTP
// configuration.
//
//	GET /api/admin/email/config
//	  -> { "configured": bool, "from": "alice@example.org" }
//
// The reply intentionally omits the host, port, username and
// password — those are operator secrets and the SPA has no
// legitimate use for them. The AdminPanel's EmailSettings widget
// only needs to render "Email notifications: configured ✓" plus the
// From address so end users know which sender to whitelist in their
// own inbox.
//
// Runtime configuration swap is NOT supported. The Sender is
// constructed once from environment variables at process boot
// (see cmd/weft-loom/main.go ; the env keys are WEFT_LOOM_SMTP_HOST,
// _PORT, _USER, _PASS, _FROM). To change credentials, update the
// service unit's Environment= block (or the operator's secrets
// store) and restart weft-loom. We deliberately do not expose a
// PUT/POST that mutates the live Sender ; credential rotation
// belongs in the deploy pipeline, not in the admin UI.

import (
	"os"
)

// emailConfigResponse is the JSON shape returned to the SPA. Mirrors
// EmailSettings.svelte's expected props ; bump both together if
// either side grows fields.
type emailConfigResponse struct {
	Configured bool   `json:"configured"`
	From       string `json:"from,omitempty"`
}

// emailConfigOutput wraps the response struct for huma. Body shape is
// byte-identical to the legacy raw handler.
type emailConfigOutput struct {
	Body emailConfigResponse
}

// readEmailConfig is the pure helper the huma operation calls. Same
// env-var read as internal/email/NewSender consumes ; never returns
// the password or username.
func readEmailConfig() emailConfigResponse {
	host := os.Getenv("WEFT_LOOM_SMTP_HOST")
	from := os.Getenv("WEFT_LOOM_SMTP_FROM")
	return emailConfigResponse{
		Configured: host != "",
		From:       from,
	}
}
