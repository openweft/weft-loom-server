// Package config parses weft-loom's HCL configuration file. Mirrors
// the openweft convention (cluster.hcl / weft-firstboot / weft-doctor).
package config

import (
	"fmt"
	"os"
	"time"

	"github.com/hashicorp/hcl/v2/gohcl"
	"github.com/hashicorp/hcl/v2/hclparse"
)

// Config is the parsed configuration.
type Config struct {
	// Listen is the bind address (e.g. ":8080"). Default :8080.
	Listen string
	// StorageRoot is where LocalStore persists project files. Required.
	StorageRoot string
	// OIDC issuer URL (dex). Empty = dev mode (auth disabled).
	OIDCIssuer string
	// OIDC client ID registered with dex.
	OIDCClientID string
	// CompileTimeout is the per-job cap. Default 5 min.
	CompileTimeout time.Duration
	// WeftAgentSocket is the path to weft-agent's unix socket the
	// compile service dials to spawn microVMs. Empty = simulated
	// compile (V0.1 default).
	WeftAgentSocket string
}

// hclConfig mirrors Config with HCL tags.
type hclConfig struct {
	Listen          string  `hcl:"listen,optional"`
	StorageRoot     string  `hcl:"storage_root"`
	OIDC            *oidcBlock `hcl:"oidc,block"`
	Compile         *compileBlock `hcl:"compile,block"`
	WeftAgentSocket string  `hcl:"weft_agent_socket,optional"`
}

type oidcBlock struct {
	Issuer   string `hcl:"issuer,optional"`
	ClientID string `hcl:"client_id,optional"`
}

type compileBlock struct {
	Timeout string `hcl:"timeout,optional"`
}

// Load parses + validates the file.
func Load(path string) (Config, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	p := hclparse.NewParser()
	f, diags := p.ParseHCL(src, path)
	if diags.HasErrors() {
		return Config{}, fmt.Errorf("parse: %s", diags.Error())
	}
	var raw hclConfig
	if diags := gohcl.DecodeBody(f.Body, nil, &raw); diags.HasErrors() {
		return Config{}, fmt.Errorf("decode: %s", diags.Error())
	}
	cfg := Config{
		Listen:          raw.Listen,
		StorageRoot:     raw.StorageRoot,
		WeftAgentSocket: raw.WeftAgentSocket,
	}
	if raw.OIDC != nil {
		cfg.OIDCIssuer = raw.OIDC.Issuer
		cfg.OIDCClientID = raw.OIDC.ClientID
	}
	if raw.Compile != nil && raw.Compile.Timeout != "" {
		d, err := time.ParseDuration(raw.Compile.Timeout)
		if err != nil {
			return Config{}, fmt.Errorf("compile.timeout: %w", err)
		}
		cfg.CompileTimeout = d
	}
	if cfg.Listen == "" {
		cfg.Listen = ":8080"
	}
	if cfg.CompileTimeout == 0 {
		cfg.CompileTimeout = 5 * time.Minute
	}
	if cfg.StorageRoot == "" {
		return Config{}, fmt.Errorf("storage_root required")
	}
	return cfg, nil
}
