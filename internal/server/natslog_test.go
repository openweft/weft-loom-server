package server

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/natsbroker"
)

func TestLogEmbeddedNATS(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))

	logEmbeddedNATS(log, &natsbroker.Embedded{URL: "nats://x", Open: true}, "dev")
	out := buf.String()
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "WITHOUT authorization") {
		t.Fatalf("open broker not logged loudly: %s", out)
	}

	buf.Reset()
	logEmbeddedNATS(log, &natsbroker.Embedded{URL: "nats://x"}, "dev")
	out = buf.String()
	if strings.Contains(out, "WITHOUT") || !strings.Contains(out, "level=INFO") {
		t.Fatalf("authorized broker logged as open: %s", out)
	}
}
