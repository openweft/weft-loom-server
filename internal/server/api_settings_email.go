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
	"net/http"
	"os"
)

// emailConfigResponse is the JSON shape returned to the SPA. Mirrors
// EmailSettings.svelte's expected props ; bump both together if
// either side grows fields.
type emailConfigResponse struct {
	Configured bool   `json:"configured"`
	From       string `json:"from,omitempty"`
}

// handleAdminEmailConfig surfaces a sanitised view of the active SMTP
// configuration. Reads from the same env vars that
// internal/email/NewSender consumes ; never returns the password or
// username. Any authenticated identity may read this — the same
// scoping rule the OCI admin endpoint uses for V0.
func (s *Server) handleAdminEmailConfig(w http.ResponseWriter, _ *http.Request) {
	host := os.Getenv("WEFT_LOOM_SMTP_HOST")
	from := os.Getenv("WEFT_LOOM_SMTP_FROM")
	resp := emailConfigResponse{
		Configured: host != "",
		From:       from,
	}
	writeJSON(w, http.StatusOK, resp)
}
