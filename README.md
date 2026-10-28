# Circle of Life

A zoomable radial tree of every tip in the [Open Tree of Life](https://tree.opentreeoflife.org) synthesis: about 2.39 million taxa, 2.27 million of them species, on one wheel. You can zoom from the whole tree of life down to a single species, click any branch for details, and search by scientific or common name (English and Portuguese).

It is a portfolio project, inspired by the "Circle of Life" visualisation of Hinchliff et al. (2015). The goal is to draw the real, complete tree in a browser, honestly. The synthesis has no branch lengths, so the rings are not time, and large fans are relationships that are still unresolved.

## How it works
- **`species ingest`** (Rust) reads the synth tree (Newick) and the OTT taxonomy, and optionally common names from the GBIF backbone. It then lays out the wheel, cuts it into level-of-detail tiles (gzipped binary, `docs/tile-format.md`) and writes one SQLite file, `data/tree.db` (about 650 MB), with an FTS5 search index.
- **`species serve`** (Rust, axum) serves three things:
  - the read API from `tree.db`: `/api/meta`, `/api/v/{version}/tiles/{level}/{sector}`, `/api/search`, `/api/nodes/{ref}`;
  - species details on demand (`/api/nodes/{ref}/about`), fetched from Wikidata, Wikipedia, Wikimedia Commons, GBIF and iNaturalist and cached in `data/cache.db`;
  - the built frontend from `web/dist`.

  Tiles and hashed assets are cached forever (`immutable`), because tile URLs carry the data version; `index.html` is `no-cache`; JSON and text are gzipped.
- **`web/`** (TypeScript, Vite, no framework) holds the frontend:
  - **Tree:** a WebGL2 renderer with additive glow.
  - **Labels:** a Canvas2D overlay.
  - **Interface:** a flat DOM HUD, the search palette and the details panel.
  - **Navigation:** van Wijk–Nuij fly-to and deep links (`?n=ott770315`).
  - **Fallback:** without WebGL2 you get a still image, and search and the panel still work.

`docs/PLAN.md` holds the architecture and phases. `docs/DESIGN.md` is the visual system, and `docs/data-sources.md` lists the sources and licences.

## Quickstart
Requirements: Rust 1.99 (pinned in `rust-toolchain.toml`), Node 26 with pnpm, `make`, `curl`, and `unzip` (only for common names).

```sh
make fetch-data            # synth tree + OTT taxonomy into data/raw (~450 MB download)
make fetch-gbif            # optional: GBIF backbone (926 MB) for common names
make ingest                # builds data/tree.db (uses backbone.zip if present; needs ~3 GB RAM)
pnpm -C web install
make check                 # rustfmt, clippy, cargo test, tsc, vitest
```

Run it:

```sh
make dev                   # API server on :3000 + Vite on :5173 (hot reload), Ctrl+C stops both
# or the production way, one process:
make build                 # web/dist + release binary
cargo run --release -- serve --data data --static web/dist
# then open http://localhost:3000
```

You do not need the full data for development: `make ingest-mini` builds `data/mini.db` from the test fixtures, and `make server-mini` serves it.

Other tasks (`make help` lists them all):
- `make smoke`: a Playwright smoke test (headless Chromium, no GPU needed). It builds, starts its own server on :3077, then loads the app, searches "homo sapiens", and expects the panel to open. It also runs the same check against the no-WebGL2 fallback.
- `make shot`: visual-QA screenshots (`web/scripts/shot.ts`).
- `make lint-design`: greps for banned design tokens.
- `make docker`: builds the container image.

Settings come from environment variables (see `.env.example`; `make` reads `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `SPECIES_DATA_DIR` | `data` | directory holding `tree.db` and `cache.db` |
| `SPECIES_STATIC_DIR` | `web/dist` | built frontend |
| `PORT` | `3000` | listen port |
| `SPECIES_CONTACT` | (unset) | contact email or page, sent in the upstream User-Agent (Wikimedia asks for one) |
| `SPECIES_PUBLIC_URL` | (unset) | public URL of the site, also sent in the User-Agent |
| `RUST_LOG` | `info` | log level (`info` logs one line per request) |

## Docker
The image holds the binary and `web/dist` only. The data is a volume mounted at `/data`.

```sh
make docker                                    # docker build -t species .
docker compose up --build                      # ./data mounted at /data, http://localhost:3000
# or by hand:
docker run --rm -p 3000:3000 --user "$(id -u):$(id -g)" -v "$PWD/data:/data" species
```

- **Stages:** `node:26-slim` builds `web/dist`; `rust:1.99-slim-trixie` builds the release binary, caching dependencies in their own layer; the runtime is `debian:trixie-slim` with `ca-certificates` and a non-root user (uid 10001).
- **Size:** about 37 MB compressed (what a registry stores and a server pulls), about 105 MB unpacked, of which 87 MB is the Debian base.
- **Health check:** `HEALTHCHECK` runs `species healthcheck`, which requests `GET /healthz` from inside the container, so the image needs no curl.
- **Write access:** the server writes `cache.db` next to `tree.db`, so `/data` must be writable by the container user:
  - **A named volume** (Coolify) starts out owned by uid 10001, the image's user. Nothing to do.
  - **A bind mount** of your own `./data` needs the container to run as you: `--user`, or `user:` in `compose.yaml`.
- **Missing data:** if `tree.db` is missing, the container exits at once with an error that names the expected path.

## Deploy to Coolify
These steps are for a self-hosted Coolify v4 with its default Traefik proxy.

1. **Build `tree.db` locally:** `make fetch-data && make fetch-gbif && make ingest`. Ingest needs about 3 GB of RAM, more than a small VPS has, so it runs on your machine.
2. **Create the application.** In a project, choose *+ New → Application → Public/Private Git repository*, point it at this repo and branch, and pick the **Dockerfile** build pack (the Dockerfile is at the repo root). Set *Ports Exposes* to `3000`.
3. **Add the persistent volume.** In the application's *Persistent Storage*, add a volume mounted at `/data`. Deploy once: the container exits with "tree database not found at /data/tree.db", which is expected at this point. That first deploy creates the volume.
4. **Upload the data** to the volume's host path:
   - Find the path on the server with `docker volume inspect <volume-name> --format '{{.Mountpoint}}'`. It is usually `/var/lib/docker/volumes/<name>/_data`.
   - Upload with rsync, which resumes and only sends changes:
     ```sh
     rsync -avP --chown=10001:10001 data/tree.db root@your-server:/var/lib/docker/volumes/<name>/_data/
     ```
   - If you upload some other way, run `chown -R 10001:10001` on that directory afterwards. The server needs write access there for `cache.db` (enrichment cache; it is created on first start). You can also upload an existing `cache.db` to keep a warm cache.
5. **Set the environment variables:**
   - `SPECIES_CONTACT=<your email or contact page>`
   - `SPECIES_PUBLIC_URL=https://<your domain>`
   - `RUST_LOG=info`

   `SPECIES_DATA_DIR`, `SPECIES_STATIC_DIR` and `PORT` are already set in the image.
6. **Set the domain** (for example `https://circle.example.org`) and **deploy**. The image's own `HEALTHCHECK` (`species healthcheck`, `/healthz`) takes precedence over a health check set in the Coolify dashboard, so you can leave that one off. If you would rather use Coolify's HTTP check, note that it needs curl or wget inside the image, which this image does not include.
7. **Verify** that the cache headers and compression survive Traefik:
   ```sh
   D=https://circle.example.org
   curl -s $D/healthz                                   # ok
   curl -sI $D/ | grep -i cache-control                 # no-cache
   V=$(curl -s $D/api/meta | sed -E 's/.*"dataVersion":"([^"]+)".*/\1/')
   curl -sI -H 'Accept-Encoding: gzip' $D/api/v/$V/tiles/0/0 | grep -iE 'cache-control|content-encoding'
   #   cache-control: public, max-age=31536000, immutable
   #   content-encoding: gzip
   curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' "$D/api/search?q=homo%20sapiens" | grep -i content-encoding   # gzip
   curl -s "$D/api/nodes/ott42322/about" | head -c 200  # enrichment works (outbound HTTPS)
   ```
   - **Fonts and images:** woff2 and images are served uncompressed on purpose, because they are already compressed.
   - **Middlewares:** if a header is missing, check that no Traefik middleware (Coolify's optional gzip, or a custom `headers` middleware) rewrites it. Leave Coolify's *Enable Gzip Compression* off, because the app compresses its own responses.

**Updating the data:** re-ingest locally, `rsync` the new `tree.db`, and restart the application. The data version changes, so browsers fetch the new tiles automatically. `cache.db` survives a re-ingest.

## Data and attribution
- **Tree and taxonomy:** CC0. These are the Open Tree of Life synthetic tree opentree16.1 and Open Tree Taxonomy 3.7.3. Cite Hinchliff et al. 2015, *PNAS* 112(41):12764–12769, and doi:10.5281/zenodo.3937741 and doi:10.5281/zenodo.3937750.
- **Common names:** the GBIF Backbone Taxonomy (2023), CC BY 4.0, doi:10.15468/39omei.
- **Species details:**
  - Wikidata (CC0).
  - Wikipedia text (CC BY-SA 4.0, attributed and linked in the panel).
  - Images from Wikimedia Commons and iNaturalist, under the licence shown with each image.
  - Occurrence data © GBIF.org contributors (CC BY 4.0).
  - Conservation status: IUCN Red List categories via Wikidata or GBIF.

The app credits every source it used in the panel footer and in the *Data & credits* dialog (from the wordmark menu). The full list, with versions and etiquette (User-Agent, rate limits), is in [`docs/data-sources.md`](docs/data-sources.md).

## Learning Rust here
The Rust side is written to be read by someone learning the language:
- simple, idiomatic code;
- every file starts with a `//!` summary that lists the "Concepts introduced here";
- the first use of each language concept carries a `// LEARN:` comment.

To read them in order as a short course:

```sh
rg "LEARN:" src            # or: grep -rn "LEARN:" src
```

Good starting points:
- `src/main.rs`: the CLI and an async `main`.
- `src/config.rs`: structs, `Option`, clap.
- `src/server/mod.rs`: axum, `Arc<Mutex<…>>`, `spawn_blocking`, middleware.
- `src/healthcheck.rs`: a std-only TCP client, the `Read`/`Write` traits.
- `src/tree/`: parsing and layout.
