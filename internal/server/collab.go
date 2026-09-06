package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-crdt/collab"
	"github.com/go-crdt/collab/pgstore"
	"github.com/go-crdt/crdt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/openweft/weft-loom-server/internal/auth"
	"github.com/openweft/weft-loom-server/internal/project"
)

// Collaborative editing used to be a relay: this server forwarded binary frames
// between browsers and decoded none of them. The comment in internal/ywebsocket
// said why — "server-side state needs a Go Yjs implementation, which is a
// several-thousand-line project on its own" — and that is no longer true.
//
// What the relay cost is not a missing feature but a silence. A room was dropped
// when its last client left, so a file's text survived only because the SPA
// writes it back through the files API. The comments on it, the record of who
// changed what and the messages beside it lived in browsers and nowhere else:
// the last person to close a tab took them, and nothing said so.
//
// go-crdt/collab holds the document here, so the comments persist because the
// server has them.
//
// # Where they are kept
//
// Wherever the projects are, which is not one place: this server boots a
// LocalStore by default and a PostgresStore for the HA deployments, and the
// documents have to follow rather than pick.
//
// With Postgres, the documents go in the same database. Its schema is written to
// be run by several replicas at once — "safe to run concurrently across
// replicas" — and a store on local disk would give each replica its own idea of
// a document; one database gives them one. Without it, they go in a directory
// beside the project files, so they are backed up with the thing they are about
// and nothing else has to be running.
//
// Choosing the first and refusing to start without it was the first version of
// this, and it was wrong in the way that matters: the default deployment has no
// Postgres, so collaborative editing would simply not have been served, with a
// line in the log saying so.

// How often a document that changed is written, and how long one nobody is in is
// kept.
//
// The first bounds what a restart costs: a comment written five seconds before a
// redeploy survives it. The second bounds what a long-lived server holds —
// without it every project anybody has opened stays in memory until the process
// ends. Reopening an evicted document costs a read from the store, not anything
// anybody wrote.
const (
	collabPersistEvery = 5 * time.Second
	collabEvictAfter   = 15 * time.Minute
)

// collabRoom is the document name a browser joins, and it is the room name the
// old bridge used, so nothing about the URL changes: "<project>:<room>".
func collabRoom(projectName, room string) string {
	if room == "" {
		room = "default"
	}
	return projectName + ":" + room
}

// projectOf takes the project back out of a document name. A name with no
// project in front of it is refused rather than treated as a project of its own,
// because that project would be one nobody can be denied.
func projectOf(document string) (string, bool) {
	name, _, ok := strings.Cut(document, ":")
	if !ok || name == "" {
		return "", false
	}
	return name, true
}

// identityKey carries the caller through to Authorize.
//
// It has to travel in the context because of where the decision happens: the
// document being joined arrives in the session's first message, not in the URL,
// so nothing running before the upgrade can decide it. The handler
// authenticates, puts the identity here, and the session asks for it once it
// knows which document it is being asked about.
type identityKey struct{}

// withIdentity is the step between authenticating and authorizing.
func (s *Server) withIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ident, ok := s.identify(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, ident)))
	})
}

// identityFrom returns who a session belongs to.
func identityFrom(ctx context.Context) (auth.Identity, bool) {
	ident, ok := ctx.Value(identityKey{}).(auth.Identity)
	return ident, ok
}

// authorizeDocument decides who may open which document, which is the same
// question as who may open which project.
//
// It asks the project store rather than keeping a rule of its own: the store
// owns the policy, and a second copy of it here would be a second thing to keep
// right.
func authorizeDocument(projects project.Store) func(context.Context, string, crdt.SiteID) error {
	return func(ctx context.Context, document string, _ crdt.SiteID) error {
		ident, ok := identityFrom(ctx)
		if !ok {
			return errors.New("collab: this session was never authenticated")
		}
		name, ok := projectOf(document)
		if !ok {
			return fmt.Errorf("collab: %q names no project", document)
		}
		if _, err := projects.ListFiles(ctx, ident, name); err != nil {
			return fmt.Errorf("collab: %s may not open %s: %w", ident.Subject, name, err)
		}
		return nil
	}
}

// pooled is a project store that keeps its projects in a database and will
// share the connections to it.
type pooled interface {
	Pool() *pgxpool.Pool
}

// rooted is a project store that keeps its files somewhere on disk. Both stores
// here are, which is what makes the fallback total rather than a hope.
type rooted interface {
	Root() string
}

// newCollabServer builds the collaborative editing server and the database
// handle behind it. Closing the handle is the caller's.
//
// It borrows the projects' own pool rather than opening a second one beside it:
// the documents belong to the same database, and a server that dialled twice
// would take twice the connections for no reason. pgstore takes a database/sql
// handle and pgx's adapter makes one from a pool.
func newCollabServer(ctx context.Context, projects project.Store, logger *slog.Logger) (*collab.Server, *sql.DB, error) {
	store, db, err := documentStore(ctx, projects)
	if err != nil {
		return nil, nil, err
	}
	return collab.NewServer(collabConfig(store, projects, logger)), db, nil
}

// collabConfig is what the server is built with, apart from the constructor so
// that a test can read the decisions rather than infer them from behaviour.
func collabConfig(store collab.Store, projects project.Store, logger *slog.Logger) collab.Config {
	return collab.Config{
		Store:        store,
		PersistEvery: collabPersistEvery,
		EvictAfter:   collabEvictAfter,
		Authorize:    authorizeDocument(projects),
		// A session may hand the server operations another site made, and with
		// no policy the server applies them. This server does not federate --
		// nothing here calls Server.Follow -- so every session speaks for
		// itself and nothing legitimately carries another site's work.
		//
		// It is not only attribution. A site identity is half of an operation's
		// name, so a forger and the real owner of that site produce different
		// characters with the same ID, and replicas that saw both diverge
		// silently and permanently. See collab.OwnSiteOnly.
		AuthorizeOperations: collab.OwnSiteOnly,
		OnEvictError: func(document string, err error) {
			// Nobody is left to return this to, and it is the one failure that
			// loses what somebody wrote. It goes to the log at the level that
			// wakes people.
			logger.Error("collab.evict.save.failed", "document", document, "err", err.Error())
		},
	}
}

// documentStore puts the documents where the projects are. The database handle
// it returns is nil when there is none, which is what the caller closes.
func documentStore(ctx context.Context, projects project.Store) (collab.Store, *sql.DB, error) {
	if shared, ok := projects.(pooled); ok {
		db := stdlib.OpenDBFromPool(shared.Pool())
		store, err := pgstore.New(db)
		if err == nil {
			// The table is made here rather than in the project schema, so the
			// store owns its own shape. Like the rest of this server's schema it
			// is idempotent and safe from several replicas booting at once.
			err = store.Migrate(ctx)
		}
		if err != nil {
			_ = db.Close()
			return nil, nil, fmt.Errorf("collab: preparing the document store: %w", err)
		}
		return store, db, nil
	}
	if onDisk, ok := projects.(rooted); ok {
		// Beside the project files rather than among them: a document is not a
		// file anybody edits by hand, and a directory of its own keeps it from
		// turning up in a listing.
		dir := filepath.Join(onDisk.Root(), ".collab")
		store, err := collab.NewDirStore(dir)
		if err != nil {
			return nil, nil, fmt.Errorf("collab: preparing the document store: %w", err)
		}
		return store, nil, nil
	}
	return nil, nil, fmt.Errorf("collab: %T keeps its projects somewhere documents cannot follow", projects)
}
