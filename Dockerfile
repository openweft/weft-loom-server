# Multi-stage build for weft-loom-server.
#
# Stage 1 : gen the openapi.json from the live huma spec (Go).
# Stage 2 : build the Svelte SPA (Node 22 ; consumes openapi.json
#           for openapi-typescript regen).
# Stage 3 : compile the Go binary with the SPA embedded via //go:embed.
# Stage 4 : minimal distroless runtime ; matches openweft infra-
#           images convention.
#
# Image lands at ghcr.io/openweft/weft-loom-server. weft-agent pulls
# it on each DC via `weft microvm pull` (or autopull from cluster.hcl)
# and runs it as a microVM bound to the per-DC service mesh.

# --- Stage 1 : openapi.json (Go-side huma spec dump) ----------------
FROM golang:1.26-bookworm AS gen
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go run ./tools/dump-openapi > openapi.json

# --- Stage 2 : SPA build (Node 22) ----------------------------------
FROM node:22-bookworm-slim AS spa
WORKDIR /build
# Copy npm manifests + lock FIRST so the install layer caches across
# source edits ; rebuild only happens on package.json / lock change.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
# Now bring in the SPA source + the openapi.json the TS client
# regenerates from. internal/web is needed because vite.config.ts
# emits the bundle there ; the //go:embed in stage 3 picks it up.
COPY web ./web
COPY internal/web ./internal/web
COPY --from=gen /build/openapi.json ./openapi.json
RUN cd web && npm run gen-api && npm run build

# --- Stage 3 : Go binary --------------------------------------------
FROM golang:1.26-bookworm AS go
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Bring in the freshly-built SPA from stage 2 — the //go:embed in
# internal/web/embed.go picks it up at compile time.
COPY --from=spa /build/internal/web/dist ./internal/web/dist
ARG VERSION=dev
ARG COMMIT=none
ARG DATE=unknown
RUN CGO_ENABLED=0 GOOS=linux \
    go build -trimpath \
      -ldflags "-X github.com/openweft/weft-loom-server/cmd/weft-loom.version=${VERSION} \
                -X github.com/openweft/weft-loom-server/cmd/weft-loom.commit=${COMMIT} \
                -X github.com/openweft/weft-loom-server/cmd/weft-loom.date=${DATE}" \
      -o /weft-loom ./cmd/weft-loom

# --- Stage 4 : runtime ----------------------------------------------
# distroless/static-debian13 : ~2 MB ; CA certs + tzdata +
# /etc/passwd with nonroot:65532. No shell, no package manager.
#
# We pre-bake a /etc/weft-loom/config.hcl (LocalStore default ; no
# Postgres) so a bare `weft microvm run <image>` boots cleanly
# without any operator-supplied mount. An HA deployment overlays
# /etc/weft-loom/config.hcl via virtio-fs share + pod-mounts the
# weft-block volume at /var/lib/weft-loom ; the baked default is
# overridden by any operator-supplied mount at the same path.

# Stage 4a : seed the writable dir with the nonroot ownership BEFORE
# the distroless FROM (distroless has no useradd/chmod). Use
# alpine as a one-shot to mkdir + chown.
FROM alpine:3.21 AS seed
RUN mkdir -p /seed/var/lib/weft-loom /seed/etc/weft-loom && \
    chown -R 65532:65532 /seed/var/lib/weft-loom

FROM gcr.io/distroless/static-debian13:nonroot
WORKDIR /app

COPY --from=go /weft-loom /usr/local/bin/weft-loom
# Default config — LocalStore, single-replica. HA setups overlay it.
COPY --chown=65532:65532 config.default.hcl /etc/weft-loom/config.hcl
# Pre-created storage_root with nonroot ownership so the binary
# can write without the operator pre-chmoding the host volume.
COPY --from=seed --chown=65532:65532 /seed/var /var

USER nonroot:nonroot
VOLUME /var/lib/weft-loom

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/weft-loom"]
CMD ["serve", "--config", "/etc/weft-loom/config.hcl"]

LABEL org.opencontainers.image.title="weft-loom-server"
LABEL org.opencontainers.image.description="Collaborative editor + sandboxed compile for openweft. Run as a microVM ; metadata in weft-ha-postgresql (HA via etcd-DCS) ; project files on a shared weft-block volume across all DCs ; SSO via dex (V0.3) ; compile dispatch via weft-agent gRPC (V0.3) ; backed by language-specific OCI sandbox images (weft-loom-texlive / -golang / -cpp / -python / -rust / -node)."
LABEL org.opencontainers.image.source="https://github.com/openweft/weft-loom-server"
LABEL org.opencontainers.image.licenses="BSD-3-Clause"
