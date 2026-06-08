# Deploying weft-loom-server in a 3-DC openweft cluster

V0.2 procedure for spinning up `weft-loom-server` as a microVM on
`dc1-r1-h1`, `dc2-r1-h1`, `dc3-r1-h1` (the openweft 3-DC live
cluster) so the desktop apps (weft-loom-app-osx / -linux / -windows)
can connect with HA failover.

## 1 — Publish the OCI image (one-shot, on tag)

A tag push (`v*`) on this repo triggers
`.github/workflows/release-oci.yml` ; the workflow builds
`ghcr.io/openweft/weft-loom-server:<version>` multi-arch
(linux/amd64 + linux/arm64) and `:latest`.

```sh
git tag v0.3.0-rc1
git push origin v0.3.0-rc1
# → GHA builds + pushes ghcr.io/openweft/weft-loom-server:0.3.0-rc1
```

Or, for ad-hoc builds without a tag, run `workflow_dispatch` from
the Actions tab with a manual tag.

## 2 — Provision shared storage

Loom is stateful — the 3 replicas serve the SAME project list. Two
backends carry that state in V0.2.1+ :

- **weft-ha-postgresql** : project metadata + ACL (small, structured,
  HA via etcd-DCS + VMFencer). One Postgres replica per DC, the
  loom-server DSN points at the cluster's load-balanced read/write
  endpoint.
- **weft-block volume** : project file content, mounted at
  `/var/lib/weft-loom` on every loom-server replica. Single
  replicated source of truth ; reads served locally on each DC,
  writes replicated synchronously to the other 2.

Provision before deploying loom :

```hcl
# tests/integration/3host-live/cluster.hcl — additions

# Postgres HA backend (already present in many openweft clusters ;
# adapt to the existing block if so).
ha_postgresql "loom-db" {
  cluster_name = "loom"
  replicas = 3
  database = "loom"
  user     = "weft-loom"
  # Operator-set password ; generate + seal via vault / SOPS.
  password_secret_ref = "loom-db-password"
}

# Shared block volume (replicated across the 3 DCs).
volume "loom-files" {
  size     = "50Gi"
  driver   = "block"
  replicas = 3
}
```

## 3 — Wire loom-server microVMs into `cluster.hcl`

One microvm block per DC, all pointing at the same image AND the
shared volume + Postgres DSN.

```hcl
# tests/integration/3host-live/cluster.hcl
#
# ...existing host blocks...

microvm "loom-dc1" {
  host  = "dc1-r1-h1"
  image = "ghcr.io/openweft/weft-loom-server:0.2.2"
  cpu   = 2
  memory_mib = 1024

  # Mount the SHARED block volume (replicated across 3 DCs).
  # Every loom-server replica reads/writes the same project files
  # via this mount ; weft-block handles the replication.
  volume_attach "loom-files" {
    mount = "/var/lib/weft-loom"
  }

  config_file "/etc/weft-loom/config.hcl" {
    source = "./config-loom.hcl"  # SAME config for all 3 DCs
  }

  network {
    # Bind the WG mesh interface ; not exposed to the host network.
    bind = "weft-mesh"
    port = 8080
  }
}

microvm "loom-dc2" {
  host  = "dc2-r1-h1"
  image = "ghcr.io/openweft/weft-loom-server:0.2.2"
  # ... same blocks ; only the host differs
}

microvm "loom-dc3" {
  host  = "dc3-r1-h1"
  image = "ghcr.io/openweft/weft-loom-server:0.2.2"
  # ... same blocks ; only the host differs
}
```

The `config-loom.hcl` is THE SAME on all 3 DCs (postgres DSN points
at the HA cluster, storage_root points at the shared mount). HA is
in the backends, not in per-instance config :

```hcl
# config-loom.hcl
listen       = ":8080"
storage_root = "/var/lib/weft-loom"

postgres {
  dsn = "postgres://weft-loom@loom-db.weft.svc:5432/loom?sslmode=require"
}

compile { timeout = "5m" }
```

## 3 — Apply

```sh
weft up --apply --config tests/integration/3host-live/cluster.hcl
```

`weft up` orchestrates `weft microvm pull` per host then
`weft microvm run` ; per-host status surfaces in the webui Inventory
panel.

## 4 — Configure the desktop apps

The 3 loom-server instances are independent (no shared storage in
V0.2 ; each DC has its own project list). Operators pick which DC
to land in via the app's cluster picker.

In each user's `~/Library/Application Support/weft-loom/app.json`
(macOS) / `~/.config/weft-loom/app.json` (Linux) /
`%APPDATA%\weft-loom\app.json` (Windows) :

```json
{
  "clusters": [
    {
      "name": "primary",
      "display_name": "Primary",
      "dcs": [
        {
          "name": "dc1",
          "kind": "wireguard",
          "wg_addr": "10.42.1.10:8080",
          "wg_peer": "loom-dc1.weft.mesh"
        },
        {
          "name": "dc2",
          "kind": "wireguard",
          "wg_addr": "10.42.2.10:8080",
          "wg_peer": "loom-dc2.weft.mesh"
        },
        {
          "name": "dc3",
          "kind": "wireguard",
          "wg_addr": "10.42.3.10:8080",
          "wg_peer": "loom-dc3.weft.mesh"
        }
      ]
    }
  ]
}
```

The app's tray menu shows the active DC + active cluster ; the user
can right-click "Switch DC" to land on a different instance. Within
a DC, `shell.Shell`'s failover gateway is transparent.

## 5 — Verify

From the desktop app's tray menu :

1. **Open Dashboard** — loads the loom SPA via the loopback gateway
2. The Navbar's status badge should flip `connecting` → `connected`
3. The `ProjectSwitcher` dropdown lists `[]` initially (no projects)
4. Use the API to create the first project :
   ```sh
   curl -X PUT http://<dc1-loom>:8080/api/projects/demo/files/main.tex \
        --data-binary @main.tex
   ```
5. Refresh the dropdown — `demo` appears, click to switch in
6. Click "Compile" — stub returns canned result (V0.2 ; V0.3 spawns
   a real `weft-loom-texlive` microVM)

## What's NOT in V0.2.2

- OIDC SSO via dex (StaticVerifier dev mode for now) — V0.3
- Real microVM compile dispatch (stub returns canned PDF link) — V0.3
- y-websocket persistence across server restarts (Yjs state lives
  in connected clients only) — V0.3 snapshots to weft-block every
  5 min via the same volume mount that Postgres already uses
- etcd-backed session store (sessions live in memory ; restarting a
  loom-server replica logs every user on that replica back out) —
  V0.3 wires etcd for sessions + compile job state

These are all "additive" — the V0.2.2 image + cluster wiring stay
unchanged across the upgrades.

## V0.2.2 storage architecture rationale

| Data | Backend | Why |
|---|---|---|
| Project metadata (name, owner, language) | weft-ha-postgresql | Structured, queryable, ACL-able, HA via etcd-DCS + VMFencer |
| Project file content | weft-block volume (3-way replica) | Large blobs ; filesystem semantics ; BLOBs in Postgres = anti-pattern |
| Yjs CRDT live state | In-memory + V0.3 snapshot to weft-block | Clients converge among themselves ; server is just a relay |
| Sessions (V0.3) | etcd | Small, lookup-frequent, leader-election native |
| Compile job state (V0.3) | etcd | Short-lived, watch-able for SSE streams |

The V0.2.2 image SHIPS the Postgres backend ; the operator opts in
via the `postgres { dsn = ... }` block. Without it, loom-server
degrades cleanly to LocalStore — single-replica dev mode.
