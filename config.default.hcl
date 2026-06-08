# Default config baked into the Docker image at
# /etc/weft-loom/config.hcl. Boots LocalStore (single-replica, no
# Postgres) so a bare `weft microvm run <image>` works out of the
# box for demos.
#
# HA / multi-replica deployments overlay /etc/weft-loom/config.hcl
# via virtio-fs share with the real `postgres { dsn = ... }` block
# and a shared weft-block volume at storage_root. See
# docs/deploy-3dc.md and config.example.hcl for the full template.

listen       = ":8080"
storage_root = "/var/lib/weft-loom"

compile {
  timeout = "5m"
}
