# weft-loom-server

Collaborative editor + sandboxed compile, openweft-native. One server
hosts multi-user editing for any language CodeMirror has a lang pack
for (LaTeX, Markdown, Go, C++, Python, Rust, JS, …) and dispatches
compile jobs to ephemeral microVMs via weft-agent. Auth via dex.

Conceptually : **Overleaf, but generic + microVM-native instead of
Docker, + openweft SSO**.

## V0.1 status

- ✅ y-websocket relay (in-memory rooms, broadcast fan-out, slow-peer drop)
- ✅ Project file store (local filesystem ; traversal-safe ; per-user isolation)
- ✅ Compile orchestration STUB (returns canned result ; V0.2 wires gRPC to weft-agent)
- ✅ HTTP/WebSocket server (cobra CLI, slog→NATS via weft-slognats)
- ✅ Auth abstraction (StaticVerifier for dev ; OIDC/dex stub for V0.2)
- ✅ Frontend skeleton (Svelte 5 + Vite + CodeMirror 6 + Yjs + y-codemirror.next)
- ⏳ Real microVM dispatch (V0.2)
- ⏳ Project persistence on weft-block volume (V0.2)
- ⏳ OIDC verifier + dex integration (V0.2)
- ⏳ PDF preview pane (V0.2)
- ⏳ Project file tree + multi-project switcher (V0.2)

## Architecture

```
Browser
  ├─ CodeMirror 6 (lang packs per language)
  ├─ Yjs (CRDT)
  └─ y-codemirror.next + y-websocket
        │ WebSocket (binary y-protocol)
        ▼
weft-loom-server (Go, CGO=0, pure-Go)
  ├─ ywebsocket.Hub : in-memory rooms, broadcast relay
  │   (no server-side CRDT decoding — clients converge among themselves)
  ├─ project.Store : project file IO
  │   (V0.1 = local FS ; V0.2 = weft-block volume)
  ├─ compile.Service : compile orchestration
  │   (V0.1 = stub ; V0.2 = gRPC to weft-agent → ephemeral microVM)
  ├─ auth.Verifier : OIDC bearer verification
  │   (V0.1 = static dev token ; V0.2 = JWKS via dex)
  └─ http.ServeMux : routes
```

### Why a relay (and not a server-side CRDT)

- the [y-protocols](https://github.com/yjs/y-protocols) wire format is binary + versioned ; a relay is forward-compatible with new protocol versions for free
- a server-side Go Yjs impl is a several-thousand-line project on its own
- relay-only is the deployment mode the upstream `y-websocket` server uses too
- persistence (snapshot CRDT state to disk every N minutes) bolts on as a separate concern

### Why microVMs (and not Docker)

- openweft policy : every compute is a microVM (~180 ms cold boot, full kernel isolation)
- per-language images (`weft-loom-texlive`, `weft-loom-golang`, `weft-loom-cpp`, …) pulled by `weft-agent` like any other openweft driver/HA image
- compile job = mount project files RO + scratch overlay, run command, stream stdout/stderr, ship artifact

## Routes

```
GET  /                                            SPA (embedded via //go:embed)
GET  /api/healthz                                 liveness
GET  /api/projects                                list visible projects
GET  /api/projects/{name}/files                   list files
GET  /api/projects/{name}/files/{path...}         read file
PUT  /api/projects/{name}/files/{path...}         write file
POST /api/projects/{name}/compile                 start compile job
GET  /api/projects/{name}/compile/{id}            SSE log + result stream
WS   /api/projects/{name}/sync                    y-websocket bridge
```

## Quick start (dev)

```sh
# Backend
cat > config.dev.hcl <<EOF
listen       = ":8080"
storage_root = "./tmp-projects"
EOF
go run ./cmd/weft-loom serve --config ./config.dev.hcl

# Frontend (in another terminal)
cd web && npm install && npm run dev
# open http://localhost:5173 — Vite proxies /api and WS to :8080
```

Two browser tabs on the same project = collab editing. Open a third
in incognito to test the "Compile" stub.

## Configuration

```hcl
listen       = ":8080"
storage_root = "/var/lib/weft-loom"

oidc {
  issuer    = "https://dex.weft.svc/"
  client_id = "weft-loom"
}

compile {
  timeout = "5m"
}

# Optional : path to weft-agent's socket. Empty = compile stub.
weft_agent_socket = "/run/weft-agent.sock"
```

## License

BSD 3-Clause — see LICENSE.
