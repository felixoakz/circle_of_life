# Circle of Life

A zoomable radial tree of all ~2.39M tips in the Open Tree of Life synthesis: one Go binary (`species ingest` builds `data/tree.db`, `species serve` serves it; `cmd/species` + `internal/`) and a Vite + TypeScript frontend in `web/` that draws with WebGPU (WebGL2 fallback).

Read before working:
- `docs/PLAN.md`: architecture, data facts, API, phases (§9). The phase you are given is your scope.
- `docs/DESIGN.md`: the visual system. Binding for anything visual.
- `docs/data-sources.md`: sources, licences, attribution text.
- `docs/tile-format.md`: the tile bytes. `docs/plan-webgpu.md` and `docs/webgpu.md`: the WebGPU renderer (plan, explainer).

## Phase status
- [x] P0 Scaffold
- [x] P1 Parse tree and taxonomy
- [x] P2 Layout, groups, LOD
- [x] P3 Tiles and tree.db writer
- [x] P4 Read API
- [x] P5 Renderer core and visual QA harness
- [x] P6 Glow, rim, orientation
- [x] P7 Labels and HUD
- [x] P8 Picking, hover, panel core, deep links
- [x] P9 Search palette and fly-to
- [x] P10 Enrichment
- [x] P11 Common names
- [x] P12 Ship
- [x] WebGPU renderer (W0–W6, `docs/plan-webgpu.md`, explainer `docs/webgpu.md`)
- [ ] P13 Stretch (only if asked)

## Commands (Makefile)
- `make check`: gofmt (no diffs), go vet, go test, tsc --noEmit, vitest run. **Run before handing back.**
- `make bin` builds `bin/species` (`CGO_ENABLED=0`); `server`, `server-mini`, `ingest`, `ingest-mini`, `build` and `smoke` build it first.
- `make test`, `make build`, `make lint-design`
- `make server` / `make server-mini` (port 3000), `make web` (Vite, proxies `/api`), `make dev` (both)
- `make fetch-data`, `make fetch-gbif`, `make ingest`, `make ingest-mini`, `make golden` (rewrite `tests/fixtures/golden_tile.bin` via `go test ./internal/ingest -run TestGoldenTile`), `make shot`, `make shot-parity` (WebGL vs WebGPU pixel diffs), `make smoke` (Playwright e2e; starts its own server on :3077), `make docker`
- `make help` lists everything.
- Ports: the smoke server uses :3077 (`SMOKE_PORT` moves it). Never touch the user's Vite on :5173 or any process you didn't start.

## Data paths
- `data/raw/labelled_supertree.tre`: synth tree opentree16.1
- `data/raw/ott3.7.3/`: OTT 3.7.3 (`taxonomy.tsv`, `synonyms.tsv`, `forwards.tsv`, `version.txt` reading "3.7draft3", which is expected)
- `data/raw/backbone.zip`: GBIF backbone (P11, via `make fetch-gbif`)
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
- Small, single-purpose modules (PLAN §7.1).
- DOM built with tiny helpers, no framework, no CSS framework, no d3.
- Brief comments where something is non-obvious.

## Toolchain notes
- Go 1.27.3 (`go.mod` says `go 1.27`); builds with `CGO_ENABLED=0` (modernc SQLite is pure Go). Docker: `golang:1.27-trixie` → `gcr.io/distroless/static-debian13`.
- TypeScript 7.0, Vite 8.3, Vitest 5.0: work together as of P0. If TS 7 ever breaks Vite or Vitest tooling, pin `typescript@6` and note it here.
- pnpm for the frontend: `pnpm -C web …`.
- Visual QA: `pnpm -C web shot [state…]` (Playwright 1.64.1, `web/scripts/shot.ts`) shoots the server at `SHOT_BASE` (default `http://localhost:3000`, which serves `web/dist`, so build first). Default is SwiftShader; `SHOT_GPU=1` uses this machine's AMD iGPU (`--use-angle=gl`) for real frame times. Camera URL format `?v=a,r,z,rot` is documented in `web/src/url.ts`. `?debug=precision` runs the max-zoom jitter test (`window.__precision`).
- Renderer flags (URL): `?renderer=webgl|webgpu` forces a backend (default WebGPU on a hardware adapter, else WebGL2; `webgpu` also accepts a software adapter); `?nowebgl` shows the fallback page; `?debug` HUD (CPU and GPU frame time, `__loseDevice`); `?debug=precision` jitter test; `?debug=parity` WGSL vs TS compute check (`window.__gpuParity`, headless: `pnpm -C web parity`); `?passes=branches,arcs,…` draws only those passes.
- Harness env: `SHOT_RENDERER=webgl|webgpu|both` (shots into `screens/<renderer>/`), `SHOT_COMPARE=<dir>` (pixel diff against earlier shots, `screens/diff/`), `SHOT_QUERY='&…'` (extra URL params), `SHOT_OUT=<dir>`; `SMOKE_WEBGPU=1 make smoke` requires WebGPU (`SMOKE_PORT` moves the smoke server). WebGPU runs use `--enable-unsafe-webgpu --use-angle=gl --enable-gpu --ignore-gpu-blocklist`; without a Vulkan driver (`vulkan-radeon`) Chrome on Linux only has SwiftShader WebGPU (software).

## Rules
- **Never commit** unless the user asks.
- Never hard-code the contact email; it comes from `SPECIES_CONTACT`.
- All visual decisions follow `docs/DESIGN.md`.
- Run `make check` before handing back.
