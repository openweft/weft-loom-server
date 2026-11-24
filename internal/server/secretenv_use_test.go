package server

import (
	"context"
	"testing"
)

func TestPickAIProviderUsesTheAnthropicSecret(t *testing.T) {
	t.Setenv("WEFT_LOOM_AI_PROVIDER", "")
	t.Setenv("OLLAMA_URL", "http://127.0.0.1:1") // closed port: Ollama unreachable
	t.Setenv("ANTHROPIC_API_KEY", "")
	if got := pickAIProvider(context.Background()); got != "" {
		t.Fatalf("no key: provider = %q, want empty", got)
	}
	t.Setenv("ANTHROPIC_API_KEY", "k")
	if got := pickAIProvider(context.Background()); got != "anthropic" {
		t.Fatalf("key set: provider = %q, want anthropic", got)
	}
}

func TestSharesCubeFSFromEnvReadsTheSecretKey(t *testing.T) {
	t.Setenv("WEFT_CUBEFS_VOLUME", "vol")
	t.Setenv("WEFT_CUBEFS_SECRET_KEY", "sk")
	c := sharesCubeFSFromEnv()
	if c == nil || c.SecretKey != "sk" || c.Volume != "vol" {
		t.Fatalf("config = %+v", c)
	}
}
