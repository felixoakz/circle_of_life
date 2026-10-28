# Circle of Life

A zoomable radial tree of all ~2.39M tips in the Open Tree of Life synthesis: one Rust binary (`species ingest` builds `data/tree.db`, `species serve` serves it) and a Vite + TypeScript + WebGL2 frontend in `web/`.

Read before working:
- `docs/PLAN.md`: architecture, data facts, API, phases (§9). The phase you are given is your scope.
- `docs/DESIGN.md`: the visual system. Binding for anything visual.
- `docs/data-sources.md`: sources, licences, attribution text.

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
- [ ] P13 Stretch (only if asked)

## Commands (Makefile)
- `make check`: fmt --check, clippy -D warnings, cargo test, tsc --noEmit, vitest run. **Run before handing back.**
- `make test`, `make build`, `make lint-design`
- `make server` / `make server-mini` (port 3000), `make web` (Vite, proxies `/api`), `make dev` (both)
- `make fetch-data`, `make fetch-gbif`, `make ingest`, `make ingest-mini`, `make golden` (rewrite `tests/fixtures/golden_tile.bin`), `make shot`, `make smoke` (Playwright e2e; starts its own server on :3077), `make docker`
- `make help` lists everything. Targets for later phases say which phase implements them.

## Data paths
- `data/raw/labelled_supertree.tre`: synth tree opentree16.1
- `data/raw/ott3.7.3/`: OTT 3.7.3 (`taxonomy.tsv`, `synonyms.tsv`, `forwards.tsv`, `version.txt` reading "3.7draft3", which is expected)
- `data/raw/backbone.zip`: GBIF backbone (P11, via `make fetch-gbif`)
- `data/tree.db`, `data/cache.db`, `data/mini.db`: built, never committed
- `docs/reference/1-5.png`: inspiration frames for visual QA

`data/` is gitignored.

## Rust conventions
The user is learning Rust. Code is simple, minimal and idiomatic first, clever never.
- No explicit lifetimes in public APIs.
- No custom macros.
- No trait objects or generics unless a library requires them.
- `anyhow` in the CLI and ingest; one `thiserror` `AppError` in the server.
- No `unsafe`.
- Prefer plain loops over clever iterator chains when that is clearer.

### Teaching comments
- Every Rust file starts with a `//!` doc saying what the file does and listing **"Concepts introduced here"**.
- `// LEARN:` marks an inline comment that teaches a language concept, so `rg "LEARN:"` reads like a course. Only the **first** occurrence of a concept in the codebase gets one; check with `rg "LEARN:"` before adding a duplicate.
- Ordinary comments explain *why*, not what.

## TypeScript conventions
- `strict` (plus `noUncheckedIndexedAccess`); no `any`.
- Small, single-purpose modules (PLAN §7.1).
- DOM built with tiny helpers, no framework, no CSS framework, no d3.
- Brief comments where something is non-obvious.

## Toolchain notes
- Rust 1.99 (edition 2024), pinned in `rust-toolchain.toml`.
- tower-http 0.7.1 builds fine next to axum 0.8.9 (checked in P0).
- TypeScript 7.0, Vite 8.3, Vitest 5.0: work together as of P0. If TS 7 ever breaks Vite or Vitest tooling, pin `typescript@6` and note it here.
- pnpm for the frontend: `pnpm -C web …`.
- Visual QA: `pnpm -C web shot [state…]` (Playwright 1.64.1, `web/scripts/shot.ts`) shoots the server at `SHOT_BASE` (default `http://localhost:3000`, which serves `web/dist`, so build first). Default is SwiftShader; `SHOT_GPU=1` uses this machine's AMD iGPU (`--use-angle=gl`) for real frame times. Camera URL format `?v=a,r,z,rot` is documented in `web/src/url.ts`. `?debug=precision` runs the max-zoom jitter test (`window.__precision`).

## Rules
- **Never commit** unless the user asks.
- Never hard-code the contact email; it comes from `SPECIES_CONTACT`.
- All visual decisions follow `docs/DESIGN.md`.
- Run `make check` before handing back.
