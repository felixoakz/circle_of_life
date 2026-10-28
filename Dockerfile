# Circle of Life: one image with the `species` binary and the built frontend.
# The data (tree.db, cache.db) is NOT in the image; mount it at /data.
#
#   docker build -t species .
#   docker run -p 3000:3000 -v "$PWD/data:/data" species
#
# Stages (PLAN §11): web → web/dist, rust → the release binary, runtime.

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
FROM rust:1.99-slim-trixie AS rust
# A C compiler for the bundled SQLite; cmake and perl for aws-lc (rustls).
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake perl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Build the dependencies against an empty program first, so this slow layer
# is cached until Cargo.toml or Cargo.lock change. (rust-toolchain.toml is
# left out on purpose: the image already is Rust 1.99, and the file would
# make rustup download clippy and rustfmt.)
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && touch src/lib.rs \
 && cargo build --release --locked \
 && rm -rf src
COPY src ./src
# `touch` so cargo sees the real sources as newer than the placeholder build.
RUN touch src/main.rs src/lib.rs \
 && cargo build --release --locked \
 && strip target/release/species

# ---- 3. Runtime --------------------------------------------------------------
FROM debian:trixie-slim
# ca-certificates: enrichment calls Wikidata, Wikipedia, GBIF and iNaturalist over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin species \
 && mkdir /data && chown species:species /data
WORKDIR /app
COPY --from=rust /app/target/release/species /usr/local/bin/species
COPY --from=web /app/web/dist /app/web/dist
USER species
ENV SPECIES_DATA_DIR=/data \
    SPECIES_STATIC_DIR=/app/web/dist \
    PORT=3000 \
    RUST_LOG=info
VOLUME /data
EXPOSE 3000
# `species healthcheck` asks the server for /healthz (no curl needed). It
# takes precedence over a health check configured in the Coolify dashboard.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["species", "healthcheck"]
ENTRYPOINT ["species"]
CMD ["serve", "--data", "/data", "--static", "/app/web/dist"]
