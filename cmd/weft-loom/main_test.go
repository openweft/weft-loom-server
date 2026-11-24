package main

import (
	"context"
	"strings"
	"testing"

	"github.com/openweft/weft-loom-server/internal/config"
)

// A secret given both as plaintext and as a reference stops serve before
// anything else starts.
func TestServeRefusesBothFormsOfASecret(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "plain")
	t.Setenv("ANTHROPIC_API_KEY_FROM", "file:/nonexistent")
	err := serve(context.Background(), config.Config{StorageRoot: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "secrets:") || strings.Contains(err.Error(), "plain") {
		t.Fatalf("err = %v", err)
	}
}
