package server

// api_notify_test.go — coverage for the @-mention notification fan-out.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/compile"
	"github.com/openweft/weft-loom-server/internal/email"
	"github.com/openweft/weft-loom-server/internal/project"
)

// stubSender records every Send call so the test can assert
// recipient + subject + body without touching real SMTP.
type stubSender struct {
	mu    sync.Mutex
	calls []stubSenderCall
}

type stubSenderCall struct {
	to      []string
	subject string
	body    string
}

func (s *stubSender) Send(_ context.Context, to []string, subject, body string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, stubSenderCall{to: append([]string(nil), to...), subject: subject, body: body})
	return nil
}

func (s *stubSender) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

func (s *stubSender) lastCall() (stubSenderCall, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.calls) == 0 {
		return stubSenderCall{}, false
	}
	return s.calls[len(s.calls)-1], true
}

func newNotifyTestServer(t *testing.T, mailer email.Sender) (*httptest.Server, *project.LocalStore, *Server) {
	t.Helper()
	root := t.TempDir()
	store := project.NewLocalStore(root)
	s, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Projects: store,
		Compiler: compile.New(store),
		Mailer:   mailer,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mux := http.NewServeMux()
	api := humago.New(mux, huma.DefaultConfig("notify-test", "v1"))
	mountSharingAPI(api, s)
	mountNotifyAPI(api, s)
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ident, ok := s.identify(r)
		if !ok {
			ident = auth.Identity{Subject: "dev-user"}
		}
		r = r.WithContext(auth.WithIdentity(r.Context(), ident))
		mux.ServeHTTP(w, r)
	})
	return httptest.NewServer(wrapped), store, s
}

func seedNotifyProject(t *testing.T, store *project.LocalStore, project, file, content string) {
	t.Helper()
	ident := auth.Identity{Subject: "dev-user"}
	if err := store.WriteFile(context.Background(), ident, project, file, strings.NewReader(content)); err != nil {
		t.Fatalf("seed %s/%s: %v", project, file, err)
	}
}

func addShare(t *testing.T, srv *httptest.Server, project, user, role string) {
	t.Helper()
	body := bytes.NewReader([]byte(`{"user":"` + user + `","role":"` + role + `"}`))
	resp, err := http.Post(srv.URL+"/api/projects/"+project+"/sharing", "application/json", body)
	if err != nil {
		t.Fatalf("share %s: %v", user, err)
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		t.Fatalf("share %s status = %d", user, resp.StatusCode)
	}
}

// TestNotifyMention_RecipientNotOnACL : a recipient missing from
// sharing.json refuses the entire request — anti-spam guard.
func TestNotifyMention_RecipientNotOnACL(t *testing.T) {
	stub := &stubSender{}
	srv, store, _ := newNotifyTestServer(t, stub)
	defer srv.Close()
	seedNotifyProject(t, store, "p1", "main.tex", "hello")
	// No share added → only dev-user (the owner) is on the ACL.
	// "outsider" is not.
	payload := `{"recipients":["outsider"],"comment_excerpt":"hi","author_name":"alice","file_path":"main.tex"}`
	resp, err := http.Post(srv.URL+"/api/projects/p1/notify-mention", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("status = %d ; want 403 ; body = %s", resp.StatusCode, body)
	}
	if stub.callCount() != 0 {
		t.Errorf("Sender.Send called %d times ; want 0 on refusal", stub.callCount())
	}
}

// TestNotifyMention_HappyPath : a recipient ON the ACL triggers a
// Sender.Send call with the right subject + recipient email.
func TestNotifyMention_HappyPath(t *testing.T) {
	stub := &stubSender{}
	srv, store, _ := newNotifyTestServer(t, stub)
	defer srv.Close()
	seedNotifyProject(t, store, "p1", "main.tex", "hello")
	// dev-user is implicit owner ; add bob as editor + alice as commenter.
	addShare(t, srv, "p1", "bob@example.com", "editor")
	addShare(t, srv, "p1", "alice@example.com", "commenter")

	payload := `{"recipients":["bob@example.com","alice@example.com"],` +
		`"recipient_emails":["bob@example.com","alice@example.com"],` +
		`"comment_excerpt":"check this out","author_name":"dev-user","file_path":"main.tex"}`
	resp, err := http.Post(srv.URL+"/api/projects/p1/notify-mention", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("status = %d ; want 202 ; body = %s", resp.StatusCode, body)
	}
	var out struct {
		Notified int `json:"notified"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Notified != 2 {
		t.Errorf("notified = %d ; want 2", out.Notified)
	}
	// Sender.Send runs in a goroutine — wait briefly for it to land.
	deadline := time.Now().Add(2 * time.Second)
	for stub.callCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if stub.callCount() == 0 {
		t.Fatalf("Sender.Send was never invoked")
	}
	call, _ := stub.lastCall()
	if !strings.Contains(call.subject, "p1") {
		t.Errorf("subject = %q ; want it to contain project name", call.subject)
	}
	if !strings.Contains(call.body, "check this out") {
		t.Errorf("body excerpt missing : %q", call.body)
	}
	if !strings.Contains(call.body, "main.tex") {
		t.Errorf("body file_path missing : %q", call.body)
	}
}

// TestNotifyMention_NilMailerNoPanic : the default Noop wiring (and
// the test path that doesn't pass a Sender) returns 202 without
// crashing — the endpoint must be safe to call when SMTP isn't
// configured.
func TestNotifyMention_NilMailerNoPanic(t *testing.T) {
	srv, store, _ := newNotifyTestServer(t, nil)
	defer srv.Close()
	seedNotifyProject(t, store, "p1", "main.tex", "hello")
	addShare(t, srv, "p1", "bob@example.com", "editor")

	payload := `{"recipients":["bob@example.com"],"recipient_emails":["bob@example.com"],` +
		`"comment_excerpt":"ping","author_name":"alice","file_path":"main.tex"}`
	resp, err := http.Post(srv.URL+"/api/projects/p1/notify-mention", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("status = %d ; want 202 ; body = %s", resp.StatusCode, body)
	}
}
