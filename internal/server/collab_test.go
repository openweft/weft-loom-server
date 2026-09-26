package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-crdt/collab"
	"github.com/go-crdt/crdt"
	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/project"
	"log/slog"
)

// The relay this replaces kept nothing. A room was dropped when its last client
// left, so a file's text survived only because the SPA writes it back through
// the files API — and the comments on it, the change log and the chat lived in
// browsers and nowhere else.
//
// The end of that story needs a database and is in collab_pg_test.go. What is
// here is the part that decides who gets in, which needs nothing.

// fakeProjects answers ListFiles the way the real store does: an error means
// the caller may not have this project.
type fakeProjects struct {
	allowed map[string]string // project -> the subject who may open it
}

func (f fakeProjects) List(context.Context, auth.Identity) ([]project.Project, error) {
	return nil, nil
}

func (f fakeProjects) ListFiles(_ context.Context, ident auth.Identity, name string) ([]project.File, error) {
	if who, ok := f.allowed[name]; ok && who == ident.Subject {
		return nil, nil
	}
	return nil, project.ErrAccessDenied
}

func (f fakeProjects) ReadFile(context.Context, auth.Identity, string, string) (io.ReadCloser, error) {
	return nil, errors.New("not used here")
}

func (f fakeProjects) WriteFile(context.Context, auth.Identity, string, string, io.Reader) error {
	return errors.New("not used here")
}

func (f fakeProjects) DeleteFile(context.Context, auth.Identity, string, string) error {
	return errors.New("not used here")
}

func (f fakeProjects) Rename(context.Context, auth.Identity, string, string) error {
	return errors.New("not used here")
}

// Who may open a document is who may open the project it belongs to, and the
// project is the part of the name in front of the colon.
func TestOnlyTheProjectsPeopleMayOpenItsDocuments(t *testing.T) {
	projects := fakeProjects{allowed: map[string]string{"thesis": "ada"}}
	authorize := authorizeDocument(projects)

	ada := context.WithValue(t.Context(), identityKey{}, auth.Identity{Subject: "ada"})
	grace := context.WithValue(t.Context(), identityKey{}, auth.Identity{Subject: "grace"})

	// Ada's own project, in every room of it.
	for _, room := range []string{"default", "ods:chapitre un.ods", "anything"} {
		if err := authorize(ada, collabRoom("thesis", room), 1); err != nil {
			t.Errorf("ada opening thesis:%s = %v", room, err)
		}
	}
	// Somebody else's, in none of them.
	for _, room := range []string{"default", "ods:chapitre un.ods"} {
		if err := authorize(grace, collabRoom("thesis", room), 2); err == nil {
			t.Errorf("grace opened thesis:%s", room)
		}
	}
	// A project nobody has.
	if err := authorize(ada, collabRoom("nobodys", "default"), 1); err == nil {
		t.Error("a project that does not exist was opened")
	}
	// A session that was never authenticated: the middleware refuses these
	// before they get here, so this is the second lock rather than the first.
	if err := authorize(t.Context(), collabRoom("thesis", "default"), 1); err == nil {
		t.Error("an unauthenticated session opened a document")
	}
	// And a name with no project in front of it names no project, rather than
	// naming one nobody can be denied.
	for _, document := range []string{"", "default", ":default"} {
		if err := authorize(ada, document, 1); err == nil {
			t.Errorf("%q was accepted as a document name", document)
		}
	}
}

// The room in the URL becomes the document name, and an empty one is "default"
// — which is what the bridge did, so nothing about the URL changes.
func TestTheRoomInTheUrlIsTheDocumentName(t *testing.T) {
	tests := []struct {
		project, room, want string
	}{
		{"thesis", "", "thesis:default"},
		{"thesis", "default", "thesis:default"},
		{"thesis", "ods:chapitre un.ods", "thesis:ods:chapitre un.ods"},
	}
	for _, tt := range tests {
		if got := collabRoom(tt.project, tt.room); got != tt.want {
			t.Errorf("collabRoom(%q, %q) = %q, want %q", tt.project, tt.room, got, tt.want)
		}
		// And the project comes back out of it, whatever the room was called.
		name, ok := projectOf(tt.want)
		if !ok || name != tt.project {
			t.Errorf("projectOf(%q) = %q, %v", tt.want, name, ok)
		}
	}
}

// The documents follow the projects rather than picking a home. This server
// boots a LocalStore by default and a PostgresStore for the HA deployments, and
// the first version of this required a database — which meant the default
// deployment would have served no collaborative editing at all, with a line in
// the log where the feature should have been.
func TestTheDocumentsFollowTheProjects(t *testing.T) {
	t.Run("on disk, beside the project files", func(t *testing.T) {
		root := t.TempDir()
		store, db, err := documentStore(t.Context(), project.NewLocalStore(root))
		if err != nil {
			t.Fatalf("a store with no database was refused: %v", err)
		}
		if db != nil {
			t.Error("a store with no database opened one")
		}
		// It works, and it works where the projects are.
		if err := store.Save(t.Context(), "thesis:default", []byte("bonjour")); err != nil {
			t.Fatal(err)
		}
		got, err := store.Load(t.Context(), "thesis:default")
		if err != nil || string(got) != "bonjour" {
			t.Fatalf("Load = %q, %v", got, err)
		}
		if _, err := os.Stat(filepath.Join(root, ".collab")); err != nil {
			t.Errorf("the documents are not beside the project files: %v", err)
		}
		// And a document nobody has written is a new one rather than an error.
		if got, err := store.Load(t.Context(), "thesis:untouched"); err != nil || got != nil {
			t.Fatalf("a new document = %q, %v", got, err)
		}
	})

	t.Run("a store documents cannot follow", func(t *testing.T) {
		if _, _, err := documentStore(t.Context(), fakeProjects{}); err == nil {
			t.Fatal("a project store with neither a database nor a disk was accepted")
		}
	})
}

// The server refuses operations a session did not make.
//
// Nothing on the wire distinguishes a participant from a federation link, so
// collab cannot refuse another site's work by default -- a link legitimately
// carries thousands of sites. This server does not federate: nothing here calls
// Server.Follow, so every session speaks for itself, and the policy costs it
// nothing.
//
// What is checked is the wiring. collab tests the policy itself; without this,
// nothing here would say the server was built with it.
func TestASessionMayNotWriteAsAnotherSite(t *testing.T) {
	cfg := collabConfig(collab.NewMemoryStore(), fakeProjects{}, slog.New(slog.DiscardHandler))
	if cfg.AuthorizeOperations == nil {
		t.Fatal("the server takes any site's operations from any session")
	}

	made := func(site crdt.SiteID) []crdt.PartOps {
		t.Helper()
		c := crdt.NewComposite(site)
		body, err := c.Text("body")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := body.Insert(0, "some words"); err != nil {
			t.Fatal(err)
		}
		return c.OpsSince(nil)
	}
	if err := cfg.AuthorizeOperations(t.Context(), "thesis:default", 7, made(7)); err != nil {
		t.Errorf("a session's own operations were refused: %v", err)
	}
	if err := cfg.AuthorizeOperations(t.Context(), "thesis:default", 7, made(8)); err == nil {
		t.Error("a session wrote as another site")
	}
}

// captured is the log a test reads back, because the level is part of the
// decision and not decoration.
type captured struct {
	records []slog.Record
}

func (c *captured) Enabled(context.Context, slog.Level) bool { return true }
func (c *captured) Handle(_ context.Context, r slog.Record) error {
	c.records = append(c.records, r.Clone())
	return nil
}
func (c *captured) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *captured) WithGroup(string) slog.Handler      { return c }

func (c *captured) last() (string, slog.Level, map[string]string) {
	if len(c.records) == 0 {
		return "", 0, nil
	}
	r := c.records[len(c.records)-1]
	attrs := map[string]string{}
	r.Attrs(func(a slog.Attr) bool { attrs[a.Key] = a.Value.String(); return true })
	return r.Message, r.Level, attrs
}

// A refusal has to reach the operator, and a collision has to be louder than a
// client writing as somebody else.
//
// Without the hook a refusal is reported to the session that caused it and to
// nobody else. That is the right and sufficient answer for a client sending
// rubbish. It is the wrong room for crdt.ErrCollidingID: two replicas chose the
// same site, and if that was not deliberate then the identities this deployment
// hands out are not unique -- which nothing inside a session can discover.
//
// The level is asserted, not just the call. A warning that should have been an
// error is a line nobody reads.
func TestAnOperatorIsToldWhenABatchIsRefused(t *testing.T) {
	log := &captured{}
	cfg := collabConfig(collab.NewMemoryStore(), fakeProjects{}, slog.New(log))
	if cfg.OnOperationsRefused == nil {
		t.Fatal("a refused batch is reported to the offending session and to nobody else")
	}

	cfg.OnOperationsRefused("thesis:default", 7, errors.New("a session of site 7 sent an operation made by site 8"))
	msg, level, attrs := log.last()
	if msg != "collab.operations.refused" || level != slog.LevelWarn {
		t.Errorf("an ordinary refusal logged %q at %v, want collab.operations.refused at WARN", msg, level)
	}
	if attrs["document"] != "thesis:default" || attrs["site"] != "7" {
		t.Errorf("the line carries %v, want the document and the session's site", attrs)
	}

	cfg.OnOperationsRefused("thesis:default", 7, fmt.Errorf("collab: operations refused: %w", crdt.ErrCollidingID))
	msg, level, attrs = log.last()
	if msg != "collab.site.collision" || level != slog.LevelError {
		t.Errorf("a collision logged %q at %v, want collab.site.collision at ERROR", msg, level)
	}
	if attrs["document"] != "thesis:default" {
		t.Errorf("the collision line carries %v, want the document", attrs)
	}
}

// A save this server cannot make has to reach the log, and a save that was REFUSED
// has to be told apart from one that failed.
//
// Without OnPersistError collab is explicit about what happens: the saves go on being
// attempted and go on failing, participants go on editing and are told nothing, and
// the work is there until the process stops and then is not. This server had no such
// hook until now, so a full disk looked exactly like a working server.
//
// The two cases are separated because the action is: collab.ErrChanged means another
// server wrote the document since this one read it — which pgstore refuses rather than
// clobbering — and the answer is to stop two replicas serving one document. Anything
// else is the store not writing at all, and the answer is the disk or the database.
func TestAnOperatorIsToldWhenASaveCannotBeMade(t *testing.T) {
	log := &captured{}
	cfg := collabConfig(collab.NewMemoryStore(), fakeProjects{}, slog.New(log))
	if cfg.OnPersistError == nil {
		t.Fatal("a periodic save that fails is silent: nothing is told about it")
	}

	cfg.OnPersistError("thesis:default", fmt.Errorf("saving: %w", collab.ErrChanged))
	msg, level, attrs := log.last()
	if msg != "collab.save.refused" || level != slog.LevelError {
		t.Errorf("a refused save logged %q at %v, want collab.save.refused at ERROR", msg, level)
	}
	if attrs["document"] != "thesis:default" {
		t.Errorf("the line carries %v, want the document", attrs)
	}
	if attrs["do"] == "" {
		t.Error("the line does not say what to do about it, which is the whole difference " +
			"between this and a save that merely failed")
	}

	cfg.OnPersistError("thesis:default", errors.New("no space left on device"))
	msg, level, _ = log.last()
	if msg != "collab.persist.failed" || level != slog.LevelError {
		t.Errorf("a failed save logged %q at %v, want collab.persist.failed at ERROR", msg, level)
	}
}
