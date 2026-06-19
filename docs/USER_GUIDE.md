# weft-loom-server — User guide

Feature walkthroughs from the editor user's perspective. For env vars,
storage layout, and operational concerns see `ADMIN_GUIDE.md`.

## Sharing a project

Two share mechanisms ship side by side : per-user invites with roles,
and a public read-only link.

### Invite collaborators (per-user, with role)

1. Open the project.
2. **File → Share with users…** in the menu bar.
3. The Sharing dialog lists current collaborators. Enter the dex
   subject (typically the user's email) and pick a role :
   - **editor**    — read + write file content + comment + accept changes
   - **commenter** — read + add comments and suggestions ; cannot edit
   - **viewer**    — read-only
4. Click *Share*. The collaborator sees the project appear in their
   ProjectSwitcher on next refresh.

Storage : the share list lives in `<project>/.weft-loom/sharing.json`
(JSON sidecar). The project owner is recorded in
`<project>/.weft-loom/owner` (one-line dex subject). Sidecars travel
with the project on rename and on `.zip` export/import.

To revoke : reopen the dialog and click the × on the row, or change
the role to a lower tier.

### Public read-only link

For one-shot read access without dex accounts (paper reviewers,
external readers) :

1. **File → Public read-only link…** opens `PublicShareDialog`.
2. Click *Enable*. The server mints an unguessable token and returns a
   URL of the form `https://<host>/?p=<project>&public=<token>`.
3. Copy the URL and share it out-of-band.
4. To revoke : click *Disable* in the same dialog (deletes the sidecar)
   or use the admin path described in `ADMIN_GUIDE.md`.

Public sessions are read-only and cannot see comments, history, or
collaborator names. Storage : `<project>/.weft-loom/public-share.json`.

## Snippets

Snippets are user-defined LaTeX (or whatever-lang) abbreviations
scoped per-project.

- Open the **Snippets** panel from the right-hand activity bar.
- Each snippet has a *trigger* (the abbreviation), a *body* (the
  expansion, may contain `$1`, `$2` placeholder markers), and an
  optional *description*.
- Save : the snippet appears in the autocomplete dropdown next to
  the language-server completions.
- Toggle the panel via the snippets button in the activity bar
  (lightning-bolt icon) or the keybinding registered for it.

Storage : `<project>/.weft-loom/snippets.json`, one JSON array. Edits
go through `PUT /api/projects/{name}/snippets` — the server validates
the schema and writes atomically. Snippets travel on rename, export,
and clone (because they sit under `.weft-loom/`).

## Renaming a project

1. Open the **ProjectSwitcher** (the project name in the navbar, or
   *File → Switch project…*).
2. Each row in the dropdown carries a small **✎** button on the right
   side, visible only on rows you own.
3. Click ✎, edit the name inline, press Enter. The server :
   - moves the project directory under your storage namespace,
   - keeps `.weft-loom/` sidecars (sharing.json, owner, snippets,
     public-share, history) attached,
   - leaves git remotes untouched (git is content-addressed),
   - returns 409 if the new name is already taken.
4. The currently-open project transparently follows the rename ;
   collaborators with the project open see a reconnect blip.

Endpoint : `POST /api/projects/{name}/rename`.

## Email notifications

Triggered when a collaborator writes a comment containing one or more
`@<subject>` mentions on the project.

How it works :

1. Comments live in the Yjs CRDT (frontend-only state).
2. After the local CRDT write succeeds, the SPA POSTs to
   `/api/projects/{name}/notify-mention` with the list of mentioned
   subjects.
3. The server checks every recipient is on the project's
   `sharing.json` (anti-spam — a malicious client cannot fan out to
   arbitrary inboxes).
4. SMTP dialog runs in a goroutine with `context.Background()` so the
   commenter never blocks on the relay.

Configuration is admin-side (env vars `WEFT_LOOM_SMTP_*`) — see
`ADMIN_GUIDE.md`. Once configured, the feature is on by default for
every project ; users cannot opt out per-project (V0.14 scope).

To verify it works as an admin : trigger a mention, then check
`/api/admin/email/config` exposes the current SMTP host (without
secrets) and the server log for the delivery line.

## History and restore

Every save creates a snapshot in the per-project history log.

- Open the **History** panel from the activity bar.
- The timeline lists snapshots newest-first with author + timestamp.
- Click a snapshot to see the inline diff against the previous one.
- Optionally **Label** a snapshot (a free-text tag, e.g. *"submitted
  v1"*) — labelled snapshots are pinned and never auto-pruned.
- Click **Restore** on a snapshot : the server makes that snapshot the
  current state with a new snapshot on top (so restoring is itself
  undoable).

Endpoints under `/api/projects/{name}/history` : `GET` list, `POST
/snapshot` (manual snapshot), `GET /diff?from=&to=`, `POST /label`,
`POST /restore`.

Storage : SQLite or Postgres depending on backend ; admin doc covers
the layout.

## Bibliography workflows

Three ingestion paths feed the same `refs.bib` file in the project.

### Zotero sync

1. Open **Settings → Bibliography → Zotero**.
2. Paste your numeric Zotero **userID** (from
   <https://www.zotero.org/settings/keys>) and a personal **API key**
   with `library:read` permission.
3. From `BibliographyPanel`, click **Sync from Zotero**. The server
   calls `api.zotero.org/users/<id>/items?format=bibtex` with your
   key, streams the BibTeX back, and the SPA appends it to `refs.bib`.

Endpoint : `POST /api/projects/{name}/zotero/sync`.

### DOI import

1. In `BibliographyPanel`, paste a DOI (e.g. `10.1145/3613424.3614249`)
   into the *Add from DOI* field.
2. Click *Resolve*. The server hits `doi.org` content negotiation,
   gets BibTeX back, and appends it to `refs.bib`.

Endpoint : `POST /api/projects/{name}/bib/from-doi`.

### arXiv search

1. Open the **arXiv** panel.
2. Type a query, browse results, click a paper to append the BibTeX
   entry to `refs.bib`.

Endpoint : `GET /api/arxiv/search?q=…`.

### Style picker (`.bst`)

For LaTeX projects with a `bibliographystyle{…}` :

- Open the **BibStylePicker** popover (next to the BibliographyPanel).
- The picker lists every `.bst` file under the project (typically in
  `refs/` or alongside `main.tex`).
- Pick one — the choice is written back into the source and the
  preview rebuilds.

## Export and import

- **Export** : *File → Export as .zip* downloads the project including
  `.weft-loom/` sidecars (so re-importing preserves snippets, sharing,
  public-share token, history).
- **Import** : `ImportZipDialog` accepts a `.zip` produced by a
  previous export. The server unpacks under the caller's storage
  namespace and refuses if the destination name collides (409).

Use cases : moving a project between deployments, archival, sharing a
self-contained reproducer.
