# weft-loom-server — Admin guide

Deployment, environment, storage, backup, security. For user-facing
feature walkthroughs see `USER_GUIDE.md`.

## Environment variable reference

The HCL config covers a deliberately minimal set (listen, storage_root,
oidc, compile timeout, weft_agent_socket). Operational knobs are env
vars — easier to compose with systemd `EnvironmentFile=` and Docker
secrets.

### Core

| Variable                              | Default            | Purpose                                                                 |
| ------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `WEFT_LOOM_STORAGE_ROOT`              | (HCL `storage_root`) | Filesystem root for LocalStore. Per-user subdirs created on demand.    |
| `WEFT_LOOM_PUBLIC_URL`                | derived from `Host` | Base URL used when minting public-share links + email bodies.          |
| `WEFT_NATS_URL`                       | empty → embedded   | NATS broker URL. Unset = embedded broker (dev mono-binary).            |
| `WEFT_LOOM_DISABLE_EMBEDDED_NATS`     | unset              | Set to `1` to refuse embedded-NATS fallback (forces external broker).  |
| `WEFT_AGENT_URL`                      | unset              | weft-agent gRPC endpoint for prod microVM dispatch.                    |
| `WEFT_LOOM_BACKEND`                   | unset              | `microvm` forces real microVM compile (requires weft CLI on PATH).     |
| `WEFT_LOOM_SHELL`                     | `bash`             | Default shell exposed to the in-editor terminal.                       |

### SMTP (email notifications)

| Variable                | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `WEFT_LOOM_SMTP_HOST`   | Hostname of the SMTP relay (e.g. `smtp.example.org`).    |
| `WEFT_LOOM_SMTP_PORT`   | Port. Default `587` (STARTTLS).                          |
| `WEFT_LOOM_SMTP_USER`   | PLAIN auth username (typically same as From).            |
| `WEFT_LOOM_SMTP_PASS`   | PLAIN auth password.                                     |
| `WEFT_LOOM_SMTP_FROM`   | Envelope + `From:` header. RFC 5322 form OK.             |

All five must be set for notifications to fire. With any one missing
the server logs `email: disabled` at startup and silently drops
mention POSTs. Check effective config via `GET /api/admin/email/config`
(returns host + port + From, no secrets).

### Workspace backend (compile sandbox)

| Variable                              | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `WEFT_LOOM_WORKSPACE_BACKEND`         | `qemu` for dev local-microVM ; otherwise stub.                          |
| `WEFT_LOOM_WORKSPACE_DIR`             | Override for `~/.weft-loom/workspaces/`.                                |
| `WEFT_LOOM_USE_WORKSPACE_COMPILE`     | Set to `1` once the workspace base image is ready (gates the path).    |
| `WEFT_LOOM_PRESPAWN_SUBJECTS`         | CSV of dex subjects to pre-warm workspace VMs for.                     |
| `WEFT_LOOM_IMAGE_LATEX`               | Override `ghcr.io/openweft/weft-loom-texlive:latest`.                  |
| `WEFT_LOOM_IMAGE_GOLANG`              | Override `ghcr.io/openweft/weft-loom-golang:latest`.                   |
| `WEFT_LOOM_IMAGE_MARKDOWN`            | Override `ghcr.io/openweft/weft-loom-markdown:latest`.                 |
| `WEFT_LOOM_IMAGE_CPP`                 | Override `ghcr.io/openweft/weft-loom-cpp:latest`.                      |
| `WEFT_LOOM_IMAGE_PYTHON`              | Override `ghcr.io/openweft/weft-loom-python:latest`.                   |
| `WEFT_LOOM_IMAGE_NODE`                | Override `ghcr.io/openweft/weft-loom-node:latest`.                     |
| `WEFT_LOOM_IMAGE_RUST`                | Override `ghcr.io/openweft/weft-loom-rust:latest`.                     |
| `WEFT_LOOM_IMAGE_CACHE`               | Override for `~/.weft-loom/images/` cache root.                        |

### Shared storage (HA)

| Variable                       | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `WEFT_LOOM_CUBEFS_MASTERS`     | CSV of CubeFS master addresses. Set = CubeFS shares mode.            |
| `WEFT_LOOM_CUBEFS_VOLUME`      | CubeFS volume name (required when masters set).                      |
| `WEFT_LOOM_TOOLS_PATH`         | Host path holding shared toolchain bundles.                          |
| `WEFT_LOOM_TOOLS`              | CSV `<logical>=<ref>` toolchain pairs.                               |

### LSP overrides

| Variable                       | Default                          | Purpose                                |
| ------------------------------ | -------------------------------- | -------------------------------------- |
| `WEFT_LOOM_LSP_TEXLAB`         | `texlab`                         | Path to texlab binary.                 |
| `WEFT_LOOM_LSP_GOPLS`          | `gopls`                          | Path to gopls binary.                  |
| `WEFT_LOOM_LSP_PYRIGHT`        | `pyright-langserver`             | Path to pyright.                       |
| `WEFT_LOOM_LSP_TS`             | `typescript-language-server`     | Path to tsserver wrapper.              |
| `WEFT_LOOM_LSP_RUSTANALYZER`   | `rust-analyzer`                  | Path to rust-analyzer.                 |
| `WEFT_LOOM_LSP_FAKE`           | unset                            | Test-only fake LSP binary path.        |

### Auth (dex / OIDC)

Auth wiring lives in the HCL `oidc { … }` block (`issuer`, `client_id`).
There is no separate `WEFT_LOOM_AUTH_*` env namespace today ; if
needed, override via HCL or extend the verifier in
`internal/auth/`. Leaving the block out keeps the StaticVerifier
(dev-only — every request authed as a single canned subject).

## Storage layout

### LocalStore mode (single-replica)

```
$WEFT_LOOM_STORAGE_ROOT/
├── <dex-subject-1>/                  per-user namespace, sanitised
│   ├── my-paper/                     project directory
│   │   ├── main.tex
│   │   ├── refs.bib
│   │   └── .weft-loom/               sidecars (travel on rename/zip)
│   │       ├── owner                 dex subject of the project owner
│   │       ├── sharing.json          collaborators + roles
│   │       ├── public-share.json     public link token (if any)
│   │       ├── snippets.json         per-project user snippets
│   │       └── history/              snapshot blobs
│   └── another-project/
└── <dex-subject-2>/
```

The per-user namespace prefix isolates one user's projects from
another's at the FS level. The server enforces traversal-safety on
every path operation. The `.weft-loom/` directory is filtered out of
the user-visible file tree but is included in `.zip` export so the
project is self-contained.

### Postgres + shared block volume (HA)

With `postgres { dsn = … }` in HCL, metadata (project list, ACL, history
labels) lives in weft-ha-postgresql, and file *content* lives on a
weft-block volume mounted on every replica at `storage_root`. Sidecars
still live alongside content under `.weft-loom/`. All three replicas
see the same FS view ; the broker (NATS) carries the cross-replica
invalidation events.

## Backup recommendations

The LocalStore root is the source of truth in single-replica mode. The
weft-block volume is the source of truth in HA mode. Both layouts
include `.weft-loom/` sidecars in-tree, so a single sync covers
content + sharing + history + snippets.

Suggested cron (single-replica) :

```sh
# Pull-side, on a backup host
rsync -aHAX --delete \
  --include='.weft-loom/' --include='.weft-loom/**' \
  weft-loom-host:/var/lib/weft-loom/ \
  /backup/weft-loom/$(date +%F)/
```

In HA mode prefer a weft-block snapshot (`weft block volume snapshot …`)
plus a postgres dump (`pg_dump` against the loom DB) — keep the two
roughly aligned in time so a restore stays consistent.

History blobs deduplicate at the snapshot level ; rsync's
`--link-dest` flag against the previous backup keeps incremental size
small.

## Revoking a public share token

User-side path : the project owner clicks *Disable* in
`PublicShareDialog`. Admin-side paths :

**API** :

```sh
curl -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://$LOOM/api/projects/$PROJECT/public-share
```

(Endpoint : `DELETE /api/projects/{name}/public-share`.)

**Filesystem** : remove the sidecar directly. Useful for batch
revocation or when SMTP/audit logs reveal a token leak :

```sh
rm $WEFT_LOOM_STORAGE_ROOT/<owner>/<project>/.weft-loom/public-share.json
```

The server reads this file on every public-share request, so removal
takes effect immediately — no restart needed.

To revoke *all* public links across a deployment :

```sh
find $WEFT_LOOM_STORAGE_ROOT -path '*/.weft-loom/public-share.json' -delete
```

## Security notes

- **Auth boundary** : the server trusts the dex bearer token to
  identify the subject and authorises against `sharing.json`. There
  is no fallback path that lets a request through unauthenticated
  except the public-share token (read-only, per-project, revocable).
- **CRDT messages bypass auth** for the WebSocket upgrade : the
  connection is authed on the upgrade, then the y-protocol is
  trusted by the relay. Implication : a member with `viewer` role
  who connects over WS can in principle still publish CRDT updates ;
  enforce read-only at the SPA today. Server-side hard enforcement is
  on the roadmap.
- **Public share tokens** are 32-byte URL-safe random. They are stored
  hashed-at-rest. Loss = full project read access until revoked.
- **CSRF** : huma handlers require either `Authorization: Bearer …`
  or the SPA's same-origin session cookie + custom header check.
  Cross-origin POSTs without the header are rejected.
- **TODO — Rate limiting** : there is no per-route or per-tenant rate
  limit in V0.14. Tracked as a separate task. In the meantime, put a
  reverse-proxy rate limit in front of `/api/projects/{name}/notify-mention`,
  `/api/projects/{name}/bib/from-doi`, `/api/arxiv/search`, and
  `/api/projects/{name}/zotero/sync` — the three of those that egress
  to external services, and the mention endpoint that can fan out
  email.
- **TLS** : terminate at a reverse proxy (Caddy / nginx) or the
  weft-agent embedded Caddy proxy. The server itself listens plain
  HTTP/HTTPS based on the HCL `listen` and there is no built-in cert
  rotation.
