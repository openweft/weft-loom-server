package lsp

import (
	"bufio"
	"strings"
	"testing"
)

func TestReadContentLength(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    int
		wantErr bool
	}{
		{"basic", "Content-Length: 42\r\n\r\n", 42, false},
		{"lowercase", "content-length: 7\r\n\r\n", 7, false},
		{"with-extra-header", "Content-Length: 9\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n", 9, false},
		{"missing-length", "Content-Type: x\r\n\r\n", 0, true},
		{"bogus-length", "Content-Length: notanumber\r\n\r\n", 0, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := bufio.NewReader(strings.NewReader(tc.input))
			got, err := readContentLength(r)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %d, want %d", got, tc.want)
			}
		})
	}
}

func TestAvailableLanguages(t *testing.T) {
	// We can't depend on any specific binary being installed in the
	// dev environment ; just confirm the function returns a sorted
	// slice without panicking + is a subset of the configured langs.
	got := AvailableLanguages()
	for i := 1; i < len(got); i++ {
		if got[i] < got[i-1] {
			t.Fatalf("AvailableLanguages not sorted : %v", got)
		}
	}
	for _, g := range got {
		if _, ok := Servers[g]; !ok {
			t.Fatalf("AvailableLanguages returned unknown lang %q", g)
		}
	}
}

func TestEncodeError(t *testing.T) {
	b := EncodeError("init-1", -32000, "boom")
	s := string(b)
	if !strings.Contains(s, `"id":"init-1"`) ||
		!strings.Contains(s, `"code":-32000`) ||
		!strings.Contains(s, `"message":"boom"`) {
		t.Fatalf("payload missing expected fields : %s", s)
	}
}

func TestServersRegistryCoversCoreLangs(t *testing.T) {
	// The catalogue should include the languages weft-loom routinely
	// edits ; any rename here should be intentional + matched in the
	// client-side lspClient.
	must := []string{"latex", "go", "python", "typescript", "javascript", "rust"}
	for _, lang := range must {
		if _, ok := Servers[lang]; !ok {
			t.Fatalf("Servers missing %q — adding new langs is allowed but removals should be deliberate", lang)
		}
	}
}
