# weft-loom-server config — mount as /etc/weft-loom/config.hcl in the
# microVM. The container's default --config flag points here.

# Bind the per-DC service-mesh interface. weft microvm wires this
# behind a WireGuard mesh ; the listener is NOT exposed on the host
# network, the desktop apps (weft-loom-app-osx / -linux / -windows)
# reach it through the same WG mesh + failover the operator
# configures in app.json (clusters[].dcs[].webui_addr).
listen = ":8080"

# Project files live on the microVM's writable volume (declared
# VOLUME /var/lib/weft-loom in the Dockerfile). Operators back this
# with a weft-block replica for HA in V0.3 ; for V0.2 demos a plain
# qcow2 disk is fine.
storage_root = "/var/lib/weft-loom"

# V0.2 : OIDC stays empty (StaticVerifier dev mode). V0.3 wires dex.
# oidc {
#   issuer    = "https://dex.weft.svc/"
#   client_id = "weft-loom-server"
# }

compile {
  # Per-job cap. V0.2 returns a canned result instantly ; V0.3
  # spawns a real microVM and the cap is load-bearing.
  timeout = "5m"
}

# Optional : path to weft-agent's socket (mounted from host). Empty
# = simulated compile (V0.2 default). V0.3 dials this for real
# microVM dispatch.
# weft_agent_socket = "/run/weft-agent.sock"
