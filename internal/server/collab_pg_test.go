package server

import (
	"bytes"
	"context"
	"database/sql"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-crdt/collab"
	"github.com/go-crdt/collab/pgstore"
	"github.com/go-crdt/crdt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

// This is the end of the story the relay could not tell. Somebody writes a
// comment, everybody closes their tab, the server is restarted — and the comment
// is still there, because the server had it rather than the browsers.
//
// It needs a real database, and says so rather than passing quietly: a skipped
// test is not a passing one, and this is the one claim the migration is for.
func TestACommentOutlivesEverybodyWhoWasThere(t *testing.T) {
	dsn := os.Getenv("WEFT_LOOM_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("WEFT_LOOM_TEST_PG_DSN is not set; this test needs the database it is about")
	}
	db := openTestDB(t, dsn)
	store, err := pgstore.New(db)
	if err != nil {
		t.Fatalf("preparing the document store: %v", err)
	}
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatalf("making the document table: %v", err)
	}

	const document = "thesis:default"
	// A server, a person, a comment, and then nobody.
	srv := collab.NewServer(collab.Config{Store: store, PersistEvery: 10 * time.Millisecond})
	front := httptest.NewServer(srv.ServeWebSocket("*"))
	url := "ws" + strings.TrimPrefix(front.URL, "http")

	ada, err := collab.Join(t.Context(), collab.WebSocket(url),
		collab.ClientConfig{Document: document, Site: crdt.DeriveSiteID([]byte("ada"))})
	if err != nil {
		t.Fatalf("joining: %v", err)
	}
	body, err := ada.Text("file:main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if err := body.Insert(0, "une phrase discutable"); err != nil {
		t.Fatal(err)
	}
	comment, err := ada.Map("comment:9f3c")
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{"body": "à revoir", "author": "ada", "resolved": "0"} {
		if err := comment.Set(key, []byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	chat, err := ada.List("chat")
	if err != nil {
		t.Fatal(err)
	}
	if err := chat.Append([]byte("on commence")); err != nil {
		t.Fatal(err)
	}

	// Everybody leaves, and the server goes away with them — a restart, a
	// redeploy, the last tab closing.
	if err := ada.Close(); err != nil {
		t.Fatal(err)
	}
	if err := srv.Close(t.Context()); err != nil {
		t.Fatalf("saving on shutdown: %v", err)
	}
	front.Close()

	// A new server, over the same database, and nobody has been here since.
	back := collab.NewServer(collab.Config{Store: store})
	t.Cleanup(func() { _ = back.Close(context.Background()) })
	second := httptest.NewServer(back.ServeWebSocket("*"))
	t.Cleanup(second.Close)

	grace, err := collab.Join(t.Context(), collab.WebSocket("ws"+strings.TrimPrefix(second.URL, "http")),
		collab.ClientConfig{Document: document, Site: crdt.DeriveSiteID([]byte("grace"))})
	if err != nil {
		t.Fatalf("rejoining: %v", err)
	}
	t.Cleanup(func() { _ = grace.Close() })

	keptBody, err := grace.Text("file:main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := keptBody.String(), "une phrase discutable"; got != want {
		t.Fatalf("the text is %q, want %q", got, want)
	}
	keptComment, err := grace.Map("comment:9f3c")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := keptComment.Get("body"); !ok || !bytes.Equal(got, []byte("à revoir")) {
		t.Fatalf("the comment is %q, want %q — this is what the relay lost", got, "à revoir")
	}
	if got := keptComment.Len(); got != 3 {
		t.Fatalf("the comment holds %d fields, want 3", got)
	}
	keptChat, err := grace.List("chat")
	if err != nil {
		t.Fatal(err)
	}
	if got := keptChat.Values(); len(got) != 1 || string(got[0]) != "on commence" {
		t.Fatalf("the chat is %q", got)
	}

	// And the flag flips on its own, which is what a map part per comment is
	// for: no delete-and-reinsert, and no duplicate if two people resolve it at
	// the same moment.
	if err := keptComment.Set("resolved", []byte("1")); err != nil {
		t.Fatal(err)
	}
	if got, _ := keptComment.Get("resolved"); string(got) != "1" {
		t.Fatalf("the flag is %q", got)
	}
	if got := keptComment.Len(); got != 3 {
		t.Fatalf("flipping a flag left %d fields, want 3", got)
	}
}

// openTestDB gives the test its own database handle, and takes the documents it
// wrote away afterwards so that running it twice is running it twice rather than
// finding what the last run left.
func openTestDB(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatalf("reaching the database: %v", err)
	}
	db := stdlib.OpenDBFromPool(pool)
	if err := db.PingContext(t.Context()); err != nil {
		t.Fatalf("reaching the database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(),
			`DELETE FROM collab_documents WHERE document LIKE 'thesis:%'`)
		_ = db.Close()
		pool.Close()
	})
	return db
}
