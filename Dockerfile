# Multi-stage build for weft-loom-server.
#
# Stage 1 generates openapi.json from the Go huma spec + builds the
# Svelte SPA. Stage 2 compiles the Go binary with the SPA embedded
# via //go:embed. Stage 3 is the minimal distroless runtime — matches
# the openweft infra-images convention.
#
# Image lands at ghcr.io/openweft/weft-loom-server. weft-agent pulls
# it on each DC via `weft microvm pull` (or autopull from cluster.hcl)
# and runs it as a microVM with the listener bound to the per-DC
# service mesh interface.

# --- Stage 1 : openapi.json + SPA ----------------------------------
# We need Go in this stage too because openapi.json is produced by
# `go run ./tools/dump-openapi`. Keeping that here avoids shipping
# the openapi.json artefact through git ; the spec is always derived
# from the live huma registration.
FROM golang:1.26-bookworm AS spa
WORKDIR /build

# Copy npm manifests FIRST so the install layer caches across source
# edits ; rebuild only happens on package.json / lock change.
COPY web/package*.json ./web/
RUN cd web && \
    apt-get update && apt-get install -y --no-install-recommends nodejs npm && \
    npm install --no-audit --no-fund && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Now the source.
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Generate openapi.json from the live huma spec, then run the Vite
# build which reads it via openapi-typescript.
RUN go run ./tools/dump-openapi > openapi.json && \
    cd web && npm run gen-api && npm run build

# --- Stage 2 : Go binary -------------------------------------------
FROM golang:1.26-bookworm AS go
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Bring in the freshly-built SPA from stage 1 — the //go:embed in
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

# --- Stage 3 : runtime ---------------------------------------------
# distroless/static-debian13 : ~2 MB ; just CA certs + tzdata +
# /etc/passwd with nonroot:65532. No shell, no package manager.
FROM gcr.io/distroless/static-debian13:nonroot
USER nonroot:nonroot
WORKDIR /app

COPY --from=go /weft-loom /usr/local/bin/weft-loom

# microVM convention : operator mounts a configurable storage volume
# at /var/lib/weft-loom, and a read-only config at
# /etc/weft-loom/config.hcl.
VOLUME /var/lib/weft-loom

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/weft-loom"]
CMD ["serve", "--config", "/etc/weft-loom/config.hcl"]

LABEL org.opencontainers.image.title="weft-loom-server"
LABEL org.opencontainers.image.description="Collaborative editor + sandboxed compile for openweft. Run as a microVM ; SSO via dex (V0.3) ; compile dispatch via weft-agent gRPC (V0.3) ; backed by language-specific OCI sandbox images (weft-loom-texlive / -golang / -cpp / -python / -rust / -node)."
LABEL org.opencontainers.image.source="https://github.com/openweft/weft-loom-server"
LABEL org.opencontainers.image.licenses="BSD-3-Clause"
