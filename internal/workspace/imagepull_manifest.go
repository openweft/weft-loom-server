package workspace

import (
	"encoding/json"

	v1 "github.com/opencontainers/image-spec/specs-go/v1"
)

// unmarshalManifest decodes raw manifest bytes into the v1.Manifest
// shape. Split into its own file so the test can stub it cheaply
// + the imagepull.go header stays focused on the pull semantics.
func unmarshalManifest(b []byte, m *v1.Manifest) error {
	return json.Unmarshal(b, m)
}
