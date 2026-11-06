# Circle of Life

A zoomable radial tree of all ~2.39M tips in the Open Tree of Life synthesis: one Go binary (`species ingest` builds `data/tree.db`, `species serve` serves it; `cmd/species` + `internal/`) and a Vite + TypeScript frontend in `web/` that draws with raw WebGL2 (a still-image fallback page without it).

Read before working:
- `docs/ARCHITECTURE.md`: architecture, data facts, ingest, API, enrichment, frontend, workflow, deploy. Code comments cite it as `ARCHITECTURE §n`.
- `docs/DESIGN.md`: the visual system. Binding for anything visual.
- `docs/data-sources.md`: sources, licences, attribution text.
- `docs/tile-format.md`: the tile bytes.

## Status
Phases P0–P12 are done; WebGL2 is the only renderer (a WebGPU backend was removed: no measured gain, narrower support); code comments still name phases (P5, P11, …) where a feature arrived. Stretch work (bloom, rim lens, compare mode, `species warm`, a pt-BR UI) only if asked.

## Commands (Makefile)
- `make check`: gofmt (no diffs), go vet, go test, tsc --noEmit, vitest run. **Run before handing back.**
- `make bin` builds `bin/species` (`CGO_ENABLED=0`); `server`, `server-mini`, `ingest`, `ingest-mini`, `build` and `smoke` build it first.
- `make test`, `make build`, `make lint-design`
- `make server` / `make server-mini` (port 3000), `make web` (Vite, proxies `/api`), `make dev` (both)
- `make fetch-data`, `make fetch-gbif`, `make ingest`, `make ingest-mini`, `make golden` (rewrite `tests/fixtures/golden_tile.bin` via `go test ./internal/ingest -run TestGoldenTile`), `make shot`, `make smoke` (Playwright e2e; builds, then starts its own server on :3077), `make docker`
- `make help` lists everything.
- Ports: the smoke server uses :3077 (`SMOKE_PORT` moves it). Never touch the user's Vite on :5173 or any process you didn't start.
- Smoke data: by default `make smoke` serves a temporary data dir (`mktemp -d`) with `data/$(SMOKE_DB)` (default `tree.db`) symlinked in read-only and `data/cache.db` (and its `-wal`) copied, removed on exit, so smoke never writes `data/cache.db`. `SMOKE_DB=mini.db` runs it on the mini tree; `SMOKE_DATA=<dir>` uses that dir (its tree.db and its own cache.db) instead.

## Data paths
- `data/raw/labelled_supertree.tre`: synth tree opentree16.1
- `data/raw/ott3.7.3/`: OTT 3.7.3 (`taxonomy.tsv`, `synonyms.tsv`, `forwards.tsv`, `version.txt` reading "3.7draft3", which is expected)
- `data/raw/backbone.zip`: GBIF backbone for common names (`make fetch-gbif`)
- `data/tree.db`, `data/cache.db`, `data/mini.db`: built, never committed
- `docs/reference/1-5.png`: inspiration frames for visual QA

`data/` is gitignored.

## Go conventions
The user is learning Go. Code is simple, minimal and idiomatic first, clever never.
- `gofmt` and `go vet` clean (both are in `make check`); no other linters.
- Wrap errors with context using `%w` (`fmt.Errorf("open %s: %w", path, err)`); return them, don't panic.
- `context.Context` is the first parameter of anything that does I/O or can be cancelled.
- No generics or reflection beyond what the standard library uses for you.
- No `init()` side effects and no global mutable state; pass dependencies in.
- No new dependencies without the user's approval (today: `modernc.org/sqlite` only).
- Prefer plain loops and early returns over clever helpers.

### Teaching comments
- Every Go file starts with a header comment saying what the file does and listing **"Concepts introduced here"**. The package doc (`// Package x …`) lives in one file per package; other files put a blank line between their header and `package`.
- `// LEARN:` marks an inline comment that teaches a language concept, so `rg "LEARN:" --type go` reads like a course. Only the **first** occurrence of a concept in the codebase gets one; check with `rg "LEARN:" --type go` before adding a duplicate.
- Ordinary comments explain *why*, not what.

## TypeScript conventions
- `strict` (plus `noUncheckedIndexedAccess`); no `any`.
- Small, single-purpose modules (ARCHITECTURE §7.1).
- DOM built with tiny helpers, no framework, no CSS framework, no d3.
- Brief comments where something is non-obvious.

## Toolchain notes
- Go 1.27.3 (`go.mod` says `go 1.27`); builds with `CGO_ENABLED=0` (modernc SQLite is pure Go). Docker: `golang:1.27-trixie` → `gcr.io/distroless/static-debian13`.
- TypeScript 7.0, Vite 8.3, Vitest 5.0: work together as of P0. If TS 7 ever breaks Vite or Vitest tooling, pin `typescript@6` and note it here.
- pnpm for the frontend: `pnpm -C web …`.
- Visual QA: `pnpm -C web shot [state…]` (Playwright 1.64.1, `web/scripts/shot.ts`) shoots the server at `SHOT_BASE` (default `http://localhost:3000`, which serves `web/dist`, so build first). Default is SwiftShader; `SHOT_GPU=1` uses this machine's AMD iGPU (`--use-angle=gl`) for real frame times. The view URL is `?v=a,z` in the locked view and `?v=a,r,z,rot` in free view (old links, from before the locked view, still parse and open in free view), documented in `web/src/url.ts`. `?shot` skips the intro and hides the cursor (implies `?still`); `?still` stops the wheel's own motion (ambient turn, fling, idle tour); `?tour=<seconds>` sets the idle tour's dwell and turns the tour on even with `?still` or `?shot`; `?reduced` forces reduced motion. `?debug=precision` runs the max-zoom jitter test (`window.__precision`).
- Renderer flags (URL): `?nowebgl` shows the fallback page; `?debug` HUD (frame time, tiles, λ); `?debug=precision` jitter test; `?passes=branches,arcs,…` draws only those passes.
- Harness env: `SHOT_COMPARE=<dir>` (pixel diff against earlier shots, into `<out>/diff/`), `SHOT_QUERY='&…'` (extra URL params), `SHOT_OUT=<dir>`; `SMOKE_PORT` moves the smoke server.

## Rules
- **Never commit** unless the user asks.
- Never hard-code the contact email; it comes from `SPECIES_CONTACT`.
- All visual decisions follow `docs/DESIGN.md`.
- Run `make check` before handing back.
