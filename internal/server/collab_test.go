package server

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/project"
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
