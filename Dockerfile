# Circle of Life: one image with the `species` binary and the built frontend.
# The data (tree.db, cache.db) is NOT in the image; mount it at /data.
#
#   docker build -t species .
#   docker run -p 3000:3000 --user "$(id -u):$(id -g)" -v "$PWD/data:/data" species
#
# (--user: a bind mount must be writable for cache.db; see README "Docker".)
#
# Stages: web → web/dist, go → a static binary, runtime (distroless, no
# shell).

# ---- 1. Frontend -------------------------------------------------------------
FROM node:26-slim AS web
# Node 26 no longer ships corepack, so pnpm comes from npm (the version the
# lockfile was written with).
RUN npm install -g pnpm@12.15.0
WORKDIR /app/web
# Dependencies first: this layer is reused until the lockfile changes.
COPY web/package.json web/pnpm-lock.yaml ./
# Playwright is only for screenshots and the smoke test; no browsers here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---- 2. Server ---------------------------------------------------------------
FROM golang:1.27-trixie AS go
WORKDIR /app
# Modules first: this layer is reused until go.mod or go.sum change.
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
# CGO_ENABLED=0: modernc's SQLite is pure Go, so the binary is fully static
# and runs on an image without libc. -trimpath drops local paths, -s -w the
# symbol and debug tables (about a third of the size).
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/species ./cmd/species \
 && mkdir /out/data

# ---- 3. Runtime --------------------------------------------------------------
# Static distroless: CA certificates (enrichment calls Wikidata, Wikipedia,
# GBIF and iNaturalist over HTTPS), tzdata and /etc/passwd, nothing else; no
# shell, no package manager.
FROM gcr.io/distroless/static-debian13
WORKDIR /app
COPY --from=go /out/species /usr/local/bin/species
COPY --from=web /app/web/dist /app/web/dist
# An empty /data owned by uid 10001, so a named volume mounted there (Coolify)
# starts out writable for cache.db. There is no shell to `mkdir`/`chown` with,
# hence the copy.
COPY --from=go --chown=10001:10001 /out/data /data
USER 10001:10001
ENV SPECIES_DATA_DIR=/data \
    SPECIES_STATIC_DIR=/app/web/dist \
    PORT=3000 \
    LOG_LEVEL=info
VOLUME /data
EXPOSE 3000
# `species healthcheck` asks the server for /healthz (no curl needed). It
# takes precedence over a health check configured in the Coolify dashboard.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["species", "healthcheck"]
ENTRYPOINT ["species"]
CMD ["serve", "--data", "/data", "--static", "/app/web/dist"]
