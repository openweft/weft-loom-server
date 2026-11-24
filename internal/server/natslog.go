package server

import (
	"log/slog"

	"github.com/openweft/weft-loom-server/internal/natsbroker"
)

// logEmbeddedNATS reports the embedded broker's start; an open broker
// (development flag) is logged loudly.
func logEmbeddedNATS(log *slog.Logger, b *natsbroker.Embedded, why string) {
	if b.Open {
		log.Error("SECURITY: embedded nats started WITHOUT authorization ("+natsbroker.EnvAllowNoAuth+"=1): any local client can read every subject, including share credentials. Development only.",
			"url", b.URL, "for", why)
		return
	}
	log.Info("embedded nats: started with authorization", "url", b.URL, "for", why)
}
