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

## 2 — Wire into `cluster.hcl`

Add a microvm block per DC pointing at the image. The same image
runs on every DC (stateless ; project files live on per-DC volumes).

```hcl
# tests/integration/3host-live/cluster.hcl
#
# ...existing host blocks...

microvm "loom-dc1" {
  host  = "dc1-r1-h1"
  image = "ghcr.io/openweft/weft-loom-server:0.3.0-rc1"
  cpu   = 2
  memory_mib = 1024

  volume "data" {
    size = "10Gi"
    mount = "/var/lib/weft-loom"
  }

  config_file "/etc/weft-loom/config.hcl" {
    source = "./config-loom-dc1.hcl"
  }

  network {
    # Bind the WG mesh interface ; not exposed to the host network.
    bind = "weft-mesh"
    port = 8080
  }
}

microvm "loom-dc2" {
  host  = "dc2-r1-h1"
  image = "ghcr.io/openweft/weft-loom-server:0.3.0-rc1"
  # ... same structure with dc2-specific config_file
}

microvm "loom-dc3" {
  host  = "dc3-r1-h1"
  image = "ghcr.io/openweft/weft-loom-server:0.3.0-rc1"
  # ... same structure with dc3-specific config_file
}
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

## What's NOT in V0.2

- Shared / replicated storage across DCs (each instance has its own
  project files) — V0.3 mounts the same weft-block volume on all 3
- OIDC SSO via dex (StaticVerifier dev mode for now) — V0.3
- Real microVM compile dispatch (stub returns canned PDF link) — V0.3
- y-websocket persistence across server restarts (Yjs state lives
  in connected clients only) — V0.3 snapshots to disk every 5 min

These are all "additive" — the V0.2 image + cluster wiring stay
unchanged across the upgrades.
