package toolshare

// extract.go — pull an OCI image layer (tar / tar+gz / tar+zstd)
// into a directory, honouring overlay-style whiteouts so a layer
// removing a path from the lower deletes the entry on disk too.

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"

	v1 "github.com/opencontainers/image-spec/specs-go/v1"
)

// unmarshalManifest decodes raw bytes into v1.Manifest. Split out so
// the same helper is reusable from the puller's manifest path.
func unmarshalManifest(b []byte, m *v1.Manifest) error {
	return json.Unmarshal(b, m)
}

// extractLayer untars one OCI layer blob into rootfs. mediaType
// signals the compression : application/vnd.oci.image.layer.v1.tar
// is uncompressed, .tar+gzip is gzip-wrapped, .tar+zstd is zstd
// (left as future work — texlive Docker uses gzip).
func extractLayer(r io.Reader, rootfs, mediaType string) error {
	var stream io.Reader = r
	switch {
	case strings.Contains(mediaType, "gzip"), strings.HasSuffix(mediaType, "+gzip"):
		gz, err := gzip.NewReader(r)
		if err != nil {
			return err
		}
		defer gz.Close()
		stream = gz
	}

	tr := tar.NewReader(stream)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(hdr.Name)
		// Whiteout : a file/dir starting with `.wh.` in OCI semantics
		// removes the matching path from the lower layer. Honour it
		// so layered images extract correctly.
		base := filepath.Base(name)
		if strings.HasPrefix(base, ".wh.") {
			target := filepath.Join(rootfs, filepath.Dir(name), strings.TrimPrefix(base, ".wh."))
			_ = os.RemoveAll(target)
			continue
		}
		dst := filepath.Join(rootfs, name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, os.FileMode(hdr.Mode)|0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		case tar.TypeSymlink:
			_ = os.Remove(dst)
			if err := os.Symlink(hdr.Linkname, dst); err != nil {
				return err
			}
		case tar.TypeLink:
			source := filepath.Join(rootfs, hdr.Linkname)
			_ = os.Remove(dst)
			_ = os.Link(source, dst)
		default:
			// Skip devices, fifos, etc. — tool images shouldn't ship them.
		}
	}
}
