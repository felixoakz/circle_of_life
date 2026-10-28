# Circle of Life: implementation plan (final)

A zoomable radial tree of all ~2.39 million tips in the Open Tree of Life synthesis. You can zoom from the whole wheel down to single species, click any node for details, and search by scientific or common name.

**Companion docs.** An implementing agent needs this file, `docs/DESIGN.md` (visual system, binding for anything visual) and `CLAUDE.md` (conventions; its content is specified in §12 and written in P0). Sources and licences are in `docs/data-sources.md`.

**Inspiration.** The reference frames from the inspiration video are in `docs/reference/1.png … 5.png` (copied there in P0).

- **5.png** and **4.png**: the whole wheel. Thin grey elbow branches turn the group colour near a glowing, furry rim, with a small empty ring at the centre.
- **3.png**: an "Animals" label and a "You are here" leader.
- **1.png** and **2.png**: deep zoom, auto-oriented to horizontal. Glowing terminal bars, species names outside the rim, and *Homo sapiens* in white with a long leader bar.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Backend | Rust (edition 2024, toolchain 1.99): axum + tokio + rusqlite. One binary with `ingest` and `serve` subcommands. |
| Storage | SQLite. `tree.db` is immutable, rebuilt by ingest, opened read-only. `cache.db` is mutable and holds enrichment. One `Mutex<Connection>` per file (no pool crate). |
| Tree data | OpenTree synth **opentree16.1** `labelled_supertree.tre` plus **OTT 3.7.3** `taxonomy.tsv`. Both are CC0 and already downloaded (§2.1). |
| Dates | None exist in synth, so there are **no time rings and no Mya**. |
| Polytomies | Drawn as honest fans. The UI says "unresolved". |
| Layout | Dendrogram, leaves equally spaced on the rim. Radius `r = r0 + (1−r0)·d/(d+h)`. No gaps between groups and no collapsing of monotypic chains (measured; see §3.4). |
| LOD | Additive angular tiles (§3.6): every node is stored exactly once, at the level where its arc becomes ≥ 1/P of a sector. |
| Glow | **Analytic glow in v1**: additive blending, soft-edged quads and an analytic rim ring. No bloom FBO, no half-float, no tone mapping. Bloom is a stretch item (§9, P13). |
| Frontend | Vite 8 + TypeScript, vanilla DOM, raw WebGL2 for the tree, Canvas2D overlay for labels. |
| Enrichment | Lazy on click, cached in `cache.db` as one JSON document per node. Wikidata is looked up by OTT id (P9157), with GBIF, Wikipedia, Commons and iNaturalist behind it. |
| Common names | Phase 11, from the **GBIF Backbone `VernacularName.tsv`**, joined by the integer GBIF key that OTT `sourceinfo` already carries. Languages en + pt. |
| Visual QA | A Playwright screenshot script (`web/scripts/shot.ts`), then reviewer critique rounds against the reference frames. |
| Git | Implementing agents do **not** commit unless the user asks. |

---

## 1. Architecture

```
                    ┌─────────────── species (one Rust binary) ───────────────┐
 raw data ──ingest─▶│ tree/ (parse, layout, LOD) ─▶ tiles.rs ─▶ data/tree.db  │
 (OTT, synth,       │                                                         │
  GBIF vernacular)  │ serve: axum router                                      │
                    │   /api/meta, /api/v/{ver}/tiles/…  ◀── tree.db (ro)     │
 browser ◀──HTTP──▶ │   /api/search, /api/nodes/{ref}    ◀── tree.db (ro)     │
  (WebGL2 + DOM)    │   /api/nodes/{ref}/about ─▶ enrich/ ─▶ cache.db (rw)    │
                    │   /*  static web/dist                     │             │
                    └───────────────────────────────────────────┼─────────────┘
                                                                ▼
                        Wikidata · Wikipedia · Commons · GBIF · iNaturalist
```

The work splits into an offline step and an online step.

- **Offline: `species ingest`.** Parses the tree and the taxonomy, computes the layout and the LOD levels, cuts binary tiles and writes `tree.db`. Expect about 1–2 minutes and under 3 GB of RAM.
- **Online: `species serve`.** Serves `tree.db` without computing anything per request. Tiles are pre-gzipped blobs sent with `immutable` caching. Only the `/about` endpoint touches the network, and only on a cache miss.

### 1.1 Crates (verified 2026-10-27 on crates.io)

| Crate | Version | Features / notes |
|---|---|---|
| `tokio` | 1.54 | `rt-multi-thread`, `macros`, `signal`, `sync`, `time` |
| `axum` | 0.8.9 | Default features. Route syntax is `/{param}` (0.8). |
| `tower-http` | **0.7.1** | `fs`, `trace`, `compression-gzip`, `set-header`. axum 0.8.9's tower-http 0.6 dependency is optional and not enabled by default, and both use tower 0.5 and http 1, so 0.7 layers work. **Confirmed in P0:** `ServeDir` + `TraceLayer` from 0.7.1 compile and pass tests with axum 0.8.9. |
| `tower` | 0.5 | Dev-dependency, for `ServiceExt::oneshot` in tests. |
| `rusqlite` | **0.41** | `bundled`. The bundled `libsqlite3-sys` 0.39 compiles with `-DSQLITE_ENABLE_FTS5` (checked in its `build.rs`). |
| `reqwest` | **0.13.5** | Keep default features, which already use rustls with the platform verifier. Add `json` and `query`: in 0.13, `.query()` is behind an opt-in feature. The runtime image needs `ca-certificates`. TLS uses aws-lc-rs, which needs a C toolchain (present in `rust:` images). |
| `serde` / `serde_json` | 1.0 | `derive` |
| `clap` | 4.6 | `derive` |
| `tracing` / `tracing-subscriber` | 0.1 / 0.3 | `env-filter` |
| `anyhow` / `thiserror` | 1.0 / 2.0 | `anyhow` in ingest and main; one `AppError` (thiserror) in the server |
| `flate2` | 1.1 | Gzips tiles at ingest. |
| `tempfile` | latest | Dev-only. |

**Not used, on purpose:**
- `r2d2` and `r2d2_sqlite`. Two `Mutex<Connection>` are enough for a portfolio. §5.3 explains why and how to upgrade.
- A Newick crate. The parser is hand-written: about 100 lines and a good exercise.
- `csv`. TSVs are split by hand, since OTT's `\t|\t` separator is non-standard anyway.
- `rust-embed`. Static files are served from `web/dist` on disk.

### 1.2 Frontend toolchain (verified on npm)
- **Vite 8.3** (Rolldown-based) and **Vitest 5**.
- **TypeScript 7.0**, the native compiler: `tsc --noEmit` for type checking. If Vite or Vitest tooling misbehaves with TS 7, pin `typescript@6` and note it in CLAUDE.md.
- **Playwright 1.64**, a dev dependency used for screenshots and the smoke test.
- **Fonts** are self-hosted through Fontsource, so there are no Google requests at runtime:
  - `@fontsource-variable/hanken-grotesk`
  - `@fontsource-variable/source-serif-4`, importing `wght-italic.css` only (about 52 KB latin; the `opsz-italic` file is 130 KB, so optical sizing is dropped to meet the font budget in §7.12)
  - `@fontsource/spline-sans-mono`, 400 only
- No CSS framework and no UI framework. No d3: the van Wijk–Nuij zoom is about 40 lines in `flyto.ts`.

---

## 2. Data

### 2.1 Inputs and local copies (already downloaded)

| File | Local path | Canonical URL |
|---|---|---|
| Synth tree | `data/raw/labelled_supertree.tre` (31 MB) | `https://files.opentreeoflife.org/synthesis/opentree16.1/output/labelled_supertree/labelled_supertree.tre` |
| OTT 3.7.3 | `data/raw/ott3.7.3/` (`taxonomy.tsv` 417 MB, `synonyms.tsv`, `forwards.tsv`, `version.txt`) | `https://files.opentreeoflife.org/ott/ott3.7.3/ott3.7.3.tgz` |
| GBIF Backbone (P11 only) | `data/raw/backbone.zip` (not downloaded yet; `make fetch-gbif`) | `https://hosted-datasets.gbif.org/datasets/backbone/current/backbone.zip` (926 MB, frozen 2023-08-28) |

P0 copied the first two from the planning session's volatile `/tmp` into `data/raw/` (gitignored). Ingest takes explicit `--tree` and `--taxonomy` paths. `make fetch-data` documents and performs the download for a fresh machine (curl + tar). `version.txt` inside the OTT folder reads `3.7draft3`; that is expected for the 3.7.3 release, so do not treat it as an error.

### 2.2 Facts measured on these files
These were checked during review (2026-10-27).

**Size and shape**
- 2,725,682 nodes in total: **2,385,875 tips** and 339,807 internal nodes.
- Every node carries a label, either `ottNNN` or `mrcaottAottB`. There are 126,018 `mrca…` nodes.
- Root `ott93302` "cellular organisms" has three children: Eukaryota, Bacteria, Archaea.

**Depth and polytomies**
- 83,305 monotypic nodes.
- Max depth 111.
- Homo sapiens (`ott770315`) is at depth 59, and only 2 of its ancestors are monotypic.
- Largest polytomies: 12,964, 12,378, 9,094, 8,550 and 6,428 children.

**Tip ranks**
- species 2,273,995
- "no rank - terminal" 78,696
- subspecies 23,063
- varietas 7,116
- genus 1,480

**Tips per group** (computed with the group rules in §3.2 step 4; reproduced exactly by the P2 dry run)

| Group | Tips |
|---|---|
| Animals | 1,490,245 |
| Plants | 441,645 |
| Fungi | 276,345 |
| Bacteria | 116,427 |
| Protists | 59,133 |
| Archaea | 2,080 |

**Major group OTT ids.** Every id below exists as a node in the synth tree **except Archaeplastida 5268475**, which is "broken" (non-monophyletic in synth). Plants are therefore defined by three roots.

| Group (id) | Root OTT ids |
|---|---|
| Animals (0) | Metazoa 691846 |
| Fungi (1) | Fungi 352914 |
| Plants (2) | Chloroplastida 361838, Rhodophyta 878953, Glaucophyta 664970 |
| Protists (3) | Eukaryota 304358 (only what is left after the above) |
| Bacteria (4) | Bacteria 844192 |
| Archaea (5) | Archaea 996421. The homonym genus is 3573640; never look groups up by name. |

Other ids that are useful for tests and UI: Chordata 125642, Arthropoda 632179, Insecta 1062253, Mammalia 244265, Aves 81461, Embryophyta 56610, SAR 5246039, Amoebozoa 1064655, Excavata 2927065.

**Formats**
- `taxonomy.tsv`: columns `uid | parent_uid | name | rank | sourceinfo | uniqname | flags`. The separator is `\t|\t` and every line ends with `\t|\t` (strip that before splitting). There is a header row.
- `sourceinfo` looks like `ncbi:9606,gbif:2436436,irmng:…`. GBIF ids are present on about 83% of tips.
- OTT `extinct` flags are unreliable (Homo sapiens itself carries `extinct`, an OTT quirk). Extinct taxa are included like any other, and the flag is **not** carried into the layout, tile flags or the UI.

---

## 3. Ingest pipeline (`species ingest`)

```
species ingest --tree data/raw/labelled_supertree.tre \
               --taxonomy data/raw/ott3.7.3/taxonomy.tsv \
               [--vernacular data/raw/backbone.zip --langs en,pt] \
               --out data/tree.db   [--dry-run]
```
Ingest writes to `tree.db.tmp`, then renames it into place atomically, so a running server is never exposed to a half-written file. The server needs a restart to pick up the new file. Every step logs its timing and node counts.

### 3.1 In-memory model: an arena
```rust
// LEARN: an "arena" stores every node in one Vec and links nodes by u32 index
// instead of Box/Rc pointers. No lifetimes, no RefCell, cache-friendly, and
// 2.7M nodes fit in a few hundred MB.
pub struct Tree {
    pub label: Vec<Label>,          // Label::Ott(u32) | Label::Mrca(String)
    pub parent: Vec<u32>,           // u32::MAX for the root
    pub children: Vec<Vec<u32>>,    // simple > clever; ~2.7M small Vecs is fine
}
```
Per-node results live in plain parallel `Vec`s that a `Layout` struct owns: `leaf_count`, `height`, `depth`, `group`, `level`, and so on. Using parallel Vecs instead of one big struct keeps each step readable. Each step is a function from `&Tree` (plus earlier results) to a new `Vec`.

### 3.2 Steps
1. **Parse Newick** (`tree/newick.rs`). This is a byte scanner with an explicit stack and no recursion, since depth 111 is fine but the habit matters.
   - `(` pushes a new internal node.
   - `,` is a separator.
   - `)` pops, then reads the label that follows.
   - A bare token is a tip.
   - Labels are `ott\d+` or `mrcaott\d+ott\d+`. Support quoted labels and a missing label (as `Label::None`) only so the tests can cover them; the real file has neither.
   - Creating nodes in parse order already gives a pre-order, so the parent index is always smaller than the child index.
2. **Read the taxonomy** (`tree/taxonomy.rs`). Stream `taxonomy.tsv` line by line. Keep a row only if its uid is in the tree's set of OTT ids (a `HashMap<u32, u32>` from ott to node). Store `name`, `rank`, `flags`, and the `gbif` and `ncbi` ids parsed from `sourceinfo`.
   - `mrca` nodes have no name.
   - Report a count of tree ott ids that have no taxonomy row; it should be 0.
3. **Leaf counts and heights.** Iterate node indices in **reverse**; reversed pre-order is a valid post-order. `leaf_count[p] += leaf_count[c]` and `height[p] = max(height[p], height[c] + 1)`. There is no recursion.
4. **Groups** (`tree/groups.rs`). This is a two-pass rule and needs no lookups by name.
   - **Tips:** walk in pre-order. `group[v]` is the group of the nearest ancestor-or-self in the root-id table (§2.2), where Eukaryota maps to Protists. Every tip ends up in exactly one group.
   - **Internal nodes:** walk in post-order. A node takes its children's group if they all agree, otherwise `MIXED = 255`. This keeps Eukaryota, Opisthokonta and the root out of every single group.
   - Panic with a clear message if any root id is missing from the tree.
5. **Ladderize.** Sort each `children` list by `(leaf_count asc, ott id asc)`, which gives the sweeping spiral of 5.png. For the `mrca` tie-break, use the label string.
6. **Pre-order renumbering and angles.** Run one explicit-stack DFS over the sorted children. It emits nodes in their final pre-order (the new `id`), assigns `depth`, and numbers tips 0..N in visit order (`tip_rank`).
7. **Layout** (§3.3–3.5), **LOD** (§3.6), **tiles** (§3.7), **search names** (§5.2), then write `tree.db` in one transaction with prepared statements.

**Targets on the full data:** under 2 min, peak RSS under 3 GB, and `tree.db` around 0.5–0.8 GB. Print each of these.

### 3.3 Angles: u32 fixed point
`θ = a / 2³² · 2π`. The resolution is 1.46e-9 rad. Differences wrap correctly through `wrapping_sub`, and the sector at level L is a bit shift.

- **Tip:** `angle = ((2·tip_rank + 1) · 2³¹) / N`, computed in `u64`. Tips are evenly spaced, with no gaps between groups; the reference has none.
  - `slot = 2³² / N` is about 1,800 units per tip.
- **Internal node:** `arc_lo` is the first child's angle and `arc_hi` the last child's. `angle = arc_lo + (arc_hi − arc_lo) / 2`.
  - Arcs never wrap, because tips increase monotonically from 0 and the root spans `[slot/2, 2³² − slot/2]`.
  - A monotypic node has `arc_lo == arc_hi` and draws no arc.
- **Group runs:** contiguous runs of tips with the same group, each with `(group, angle_lo, angle_hi)`. A group can appear in more than one run; Plants probably will, because Archaeplastida is broken. They go to `meta` and drive the colour lookup table (§7.4).

### 3.4 Radius
`r(v) = r0 + (1 − r0) · d / (d + h)`, where `d` is depth from the root, `h` is height (the longest path down to a tip) and `r0 = 0.08`.

**Properties** (these are tested in P2):
- The root sits at r0 and every tip at exactly 1.0, which gives an aligned rim.
- It is strictly increasing from parent to child. Since `h_p ≥ h_c + 1`, we get `(d−1)/(d−1+h_p) ≤ (d−1)/(d+h_c) < d/(d+h_c)`.
- Huge polytomies: a parent at depth d with only tip children sits at `d/(d+1)`. Its 12,964 children fan to the rim from there, which is an honest fan.

**Monotypic chains are not collapsed.** Measured on the data: the Homo sapiens path has only 2 monotypic ancestors, and the longest path is not changed by collapsing. A monotypic node simply sits on a straight segment, which is invisible and harmless. Collapsing would add code for no visible gain. The breadcrumb keeps every node.

**Known consequence.** The median terminal branch is 3.3% of the radius; p10 is 1.8% and p90 is 27%. At the zoom of 1.png, where leaves are about 40 px apart and the rim radius is about 15M px, a terminal branch is about 500k px long. So deep zoom shows parallel glowing terminal bars with labels, which matches 1.png. The dense nested elbows of 2.png are mostly not reproducible with this data, because about 93% of tips sit in genus-level polytomies. Do not try to "fix" this in v1; see the P13 stretch item "rim lens".

### 3.5 What gets drawn per node
- **Radial segment:** from `(angle, parent_r)` to `(angle, r)`.
- **Arc** (internal nodes with two or more children): at radius `r`, from `arc_lo` to `arc_hi`.
- **Frontier extension.** If a node is drawn but its children are not drawn yet (`child_level > V`, see §3.6), its radial segment is extended to `r = 1`. Every visible lineage then reaches the rim, so the overview looks dense.
- **Rim marks** (§7.3): a leaf gets a glowing terminal bar at deep zoom. A frontier clade gets a short outward spike at overview; this is the "fur".

### 3.6 Level of detail: additive angular tiles
- At level `L ∈ 0..=Lmax`, the circle is cut into `2^L` sectors of width `W_L = 2³²/2^L`. The sector of a node is `angle >> (32 − L)`.
  - **Rust gotcha:** `x >> 32` overflows a `u32` and panics in debug builds. Write it as `if L == 0 { 0 } else { angle >> (32 − L) }`. Mark this with a `// LEARN:` comment.
- With `P = 512`, a constant stored in meta, the **intro level** of a node is the **smallest L with `leaf_count · P · 2^L ≥ N`**. Compute it with an integer loop and no float `log2`.
- `Lmax` is the smallest L with `P · 2^L ≥ N`. With N = 2,385,875 that gives **Lmax = 13**, and every tip has level 13.
- Monotone: `leaf_count(parent) ≥ leaf_count(child)`, so `level(parent) ≤ level(child)`.
- `child_level(v)` is the minimum level over v's children, or 255 for a tip.
- **Span bound (proven, and tested in P2).** For a node at level L ≥ 1, minimality gives `leaf_count · P · 2^(L−1) < N`. Since `span = leaf_count · 2³²/N`, it follows that `span < 2·W_L/P`.
  - So an arc reaches less than `W_L/P` (that is, W_L/512) beyond its own centre.
  - The node is stored in the tile of the sector containing its centre. Any viewport intersecting the arc intersects that sector widened by `W_L/P`.
  - The client widens its angular range by that margin when choosing tiles, so no branch is ever missing.
- **Continuous view level:** `λ = log2(C / (P · s))`, where C is the rim circumference in device pixels and s = 0.5 px. The integer view level is `V = clamp(floor(λ), 0, Lmax)`.
  - Every drawn node spans at least s px.
  - Tips appear at C ≈ 2.1M px, where tips are about 0.9 px apart.
  - Alpha per node is `smoothstep(L, L + 0.6, λ)`, so nothing pops in.
- **Which tiles to fetch:** levels `0..=V`, for sectors intersecting the visible angular range (widened by `W_L/P`).
  - The visible range comes from the screen rectangle seen from the origin. For a convex polygon that does not contain the origin, the extreme angles are at its corners. If the origin is inside the rectangle, the range is the full circle.
  - **Budget rule:** when the full circle is in view, fetch at most levels `0..=min(V, 6)` (≤ 127 tiles). Deep-level nodes are almost never near the centre (a node with ≤ 73 tips sits at `r < 0.1` only if `d ≪ h`). This is a documented, accepted limitation.
- **Tile size bound:** a level-L node has `leaf_count ∈ [N/(P·2^L), 2N/(P·2^L))`, and a sector holds `N/2^L` tips. So a tile holds on the order of P to 2P nodes. Expect about 291 tips per level-13 tile, at most about 1,500 nodes per tile and about 50 KB raw. Fewer than 16,383 tiles exist. An empty tile is simply absent.
- **Per-frame load:** at view level V a sector is about 256–512 px of rim, so a 1,500 px wide view touches about 3–8 sectors per level. That is about 14 levels × ≤ 8 tiles × ≤ 1,500 nodes, comfortably under 150k instances.

### 3.7 Tile binary format v2 (`docs/tile-format.md` repeats this)
All values are little-endian. Every array starts 4-byte aligned. The blob is stored gzipped in `tree.db` and served with `Content-Encoding: gzip`, so the browser receives the raw bytes.

```
offset 0   magic  "SPT2"          4 bytes
       4   u8  version (=2)  u8 level  u16 reserved(0)
       8   u32 sector
      12   u32 count            n = nodes in tile
      16   u32 internal_count   internal nodes come first
      20   u32 names_len        bytes of UTF-8 names
      24   u32 id[n]            pre-order id (== nodes.id; used for /api/nodes/{id})
           u32 parent[n]        parent pre-order id (u32::MAX for root)
           u32 angle[n]
           u32 arc_lo[n]        == angle for tips
           u32 arc_hi[n]
           u32 leaf_count[n]
           u32 first_tip[n]     rank of the clade's first tip (v2): tips are first_tip .. first_tip+leaf_count−1
           f32 r[n]
           f32 parent_r[n]
           u8  group[n]         0..5 or 255 mixed
           u8  flags[n]         bit0 tip, bit1 named, bit2 species-rank, bit3 home (Homo sapiens); bit4–7 reserved (0). OTT extinct is not surfaced, see §2.2
           u8  child_level[n]   255 for tips
           pad to 4
           u32 name_off[n+1]    offsets into names; empty for mrca nodes
           u8  names[names_len]
```
- Records are ordered **internal nodes first, then tips**, and each run is sorted by angle. The arc draw uses `instanceCount = internal_count`. Picking can binary-search tips by angle.
- The client uploads **the whole ArrayBuffer once** as a single `ARRAY_BUFFER`. One VAO per tile points each attribute at its array's byte offset: `vertexAttribIPointer` for the u32/u8 integer attributes and `vertexAttribPointer` for the f32 ones. There are no copies and no repacking.
- `id` is the internal handle and changes with every ingest; that is fine, because tile URLs carry the data version. Public URLs use the OpenTree node id string (§5).
- A **golden fixture** `tests/fixtures/golden_tile.bin` is written by a Rust test from the mini tree and decoded by a Vitest test, so both sides agree byte for byte.
- **v2 (after the P7 review)** added `first_tip`. A clade's extent on the rim is exactly the angles of tips `first_tip` and `first_tip + leaf_count − 1` (§3.3), so clade bars no longer walk loaded tiles to find it, which stopped short whenever a clade's last child had an odd number of children (*Pan*).

---

## 4. Database schema (`src/db/schema.sql`, `include_str!`)

```sql
-- tree.db  (written by ingest, opened read-only)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'meta' → JSON of GET /api/meta
CREATE TABLE nodes (
  id          INTEGER PRIMARY KEY,      -- pre-order index (rowid alias)
  parent      INTEGER,                  -- NULL for root
  node_id     TEXT NOT NULL UNIQUE,     -- OpenTree id: 'ott770315' or 'mrcaott1ott2'
  name        TEXT,                     -- NULL for mrca nodes
  rank        TEXT,
  grp         INTEGER NOT NULL,
  flags       INTEGER NOT NULL,
  leaf_count  INTEGER NOT NULL,
  child_count INTEGER NOT NULL,
  depth       INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  angle INTEGER NOT NULL, arc_lo INTEGER NOT NULL, arc_hi INTEGER NOT NULL,
  r REAL NOT NULL,
  gbif_id INTEGER, ncbi_id INTEGER
);
CREATE INDEX nodes_parent ON nodes(parent, leaf_count DESC);
CREATE VIRTUAL TABLE names_fts USING fts5(
  name, node UNINDEXED, kind UNINDEXED, lang UNINDEXED,     -- kind 0 scientific, 1 vernacular
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
CREATE TABLE tiles (level INTEGER, sector INTEGER, data BLOB NOT NULL,
                    PRIMARY KEY (level, sector)) WITHOUT ROWID;

-- cache.db  (created by serve if missing; WAL)
CREATE TABLE IF NOT EXISTS about (
  node_id    TEXT PRIMARY KEY,
  body       TEXT NOT NULL,      -- JSON of GET /about
  complete   INTEGER NOT NULL,   -- 0 if any source failed/timeouted
  fetched_at INTEGER NOT NULL    -- unix seconds
) WITHOUT ROWID;
```
- **Why one FTS table.** It is a plain FTS5 table, not external content and not a separate `names` table. One table, one insert per name.
- **Why `node_id` is a string.** All 126k unnamed nodes already have stable, OpenTree-native ids (`mrcaott…`), and tree.opentreeoflife.org accepts them. We never parse them.
- **Connections:**
  - `tree.db`: `file:…?mode=ro`, `PRAGMA query_only=1`, `PRAGMA mmap_size=1073741824`
  - `cache.db`: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=2000`

---

## 5. HTTP API (`src/server/`)
JSON responses are compressed by `CompressionLayer`, which skips responses that already carry `Content-Encoding` (checked in tower-http's source), so tiles are never double-gzipped. Errors are JSON `{"error": "…"}` with a correct status code.

### 5.1 Endpoints

**`GET /healthz`** returns `200 ok`.

**`GET /api/meta`** returns the following, with `Cache-Control: no-cache`:
```json
{ "dataVersion": "otl16.1-ott3.7.3-7f3a9c",
  "tipCount": 2385875, "speciesCount": 2273995, "nodeCount": 2725682,
  "tileP": 512, "maxLevel": 13, "r0": 0.08,
  "groups": [{"id":0,"name":"Animals","rootIds":["ott691846"],"tipCount":1490245}, …],
  "runs":   [{"group":0,"angleLo":123,"angleHi":456}, …],
  "home":   {"id":123456,"nodeId":"ott770315","angle":1234567890} }
```
`dataVersion` is the source versions plus the first 6 hex digits of a hash over the tile bytes.

**`GET /api/v/{ver}/tiles/{level}/{sector}`** returns the tile blob.
- Headers: `application/octet-stream`, `Content-Encoding: gzip`, `Cache-Control: public, max-age=31536000, immutable`.
- An absent tile returns `204`.
- A wrong `ver` returns `404`, and the client then reloads meta.

**`GET /api/search?q=homo%20sap&limit=8`**
```json
[{"id":123456,"nodeId":"ott770315","name":"Homo sapiens","rank":"species","group":0,
  "matched":"Homo sapiens","matchedKind":"scientific",
  "lineage":["Mammalia","Primates","Hominidae"],
  "leafCount":1,"angle":1234567890,"r":1.0,"level":13}]
```
- `lineage` lists up to 3 named ancestors with rank in {phylum, class, order, family}, nearest first, taken from a recursive CTE.

**`GET /api/nodes/{ref}`**
- `ref` is one of three forms, parsed into `enum NodeRef { Id(u32), Ott(u32), Mrca(String) }` by implementing `FromStr`, with a `// LEARN:` comment:
  - a pre-order `id` (digits), as sent by tile clicks
  - `ott770315`
  - `mrcaott…`
- Response:
```json
{"id":123456,"nodeId":"ott770315","name":"Homo sapiens","rank":"species","group":0,
 "flags":13,"leafCount":1,"childCount":0,"angle":…,"arcLo":…,"arcHi":…,"r":1.0,"level":13,
 "ids":{"ott":770315,"gbif":2436436,"ncbi":9606},
 "lineage":[{"id":0,"nodeId":"ott93302","name":"cellular organisms","rank":"no rank","angle":…,"r":0.08}, …],
 "children":{"total":0,"top":[{"id":…,"nodeId":…,"name":…,"rank":…,"leafCount":…}]},
 "namedAncestor":null}
```
- `lineage` runs root→parent and includes geometry, so the client can draw the selection path.
- `children.top` holds the 50 largest children. The UI shows `total`, and if `total > 2` it says "N direct descendants, relationships unresolved".
- For an unnamed node, `namedAncestor` is the nearest named ancestor. The panel titles the node "Unnamed clade within *Felidae*".

**`GET /api/nodes/{ref}/about`** returns the enrichment document (§6.3).
- Headers: `Cache-Control: public, max-age=86400`.
- This endpoint may take a few seconds on a miss. The panel shows the core data first.

**`/*`** serves `web/dist` through `ServeDir` with an `index.html` fallback.
- Hashed assets get `immutable` cache headers.
- `index.html` gets `no-cache`.

### 5.2 Search
1. **Normalise the query:** trim it, then lowercase it. If it is shorter than 2 chars, return `[]`.
2. **Tokenise** on whitespace. Drop `"` characters, then build `"tok1"* AND "tok2"*`.
3. **Fetch candidates:** `SELECT node, name, kind, bm25(names_fts) … MATCH ? ORDER BY rank LIMIT 64`.
4. **Re-rank in Rust**, with the score as a sum:
   - exact full-name match: +100
   - name starts with the query: +20
   - scientific name (`kind=0`): +5
   - `+ 2·log10(leaf_count+1)`, so clades like "Felidae" beat obscure tips
   - `+ 1` if the tip is species rank
   - then dedupe by node and take `limit`.
5. **Goal:** "homo sap" returns Homo sapiens first, and "felidae" returns Felidae first. With P11, "human", "lion" and "onça" work too.

### 5.3 DB access in the server
```rust
pub struct AppState { tree: Arc<Mutex<Connection>>, cache: Arc<Mutex<Connection>>, meta: Arc<Meta>, http: reqwest::Client, limits: Limits }
```
- Every query runs inside `tokio::task::spawn_blocking(move || { let conn = tree.lock().unwrap(); … })`. Add a `// LEARN:` comment on why blocking code must not run on async worker threads.
- **Why not a pool.** Queries take tens to hundreds of microseconds. A burst of 30 tile reads, serialised, costs about 3 ms, which is invisible for a portfolio.
- **Upgrade path, if load tests show contention:** a `Vec<Mutex<Connection>>` with round-robin, about 15 lines. Do not add r2d2.

---

## 6. Enrichment (`src/enrich/`): lazy, cached, attributed

### 6.1 Flow for `GET /api/nodes/{ref}/about`
1. Look up the node in `tree.db` to get `node_id`, name, rank, `gbif_id`, the lineage, and the ott id if any.
2. Check the cache: if the `about` row is fresh, return it. Fresh means 30 days when `complete=1`, or 1 day when `complete=0`.
3. **Stage A, in parallel** with `tokio::join!` and a 4 s timeout each:
   - **Wikidata item.** `GET https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:P9157={ott}&srlimit=5&format=json` returns QIDs; Homo sapiens gives 2 hits, so expect several.
     - Then `action=wbgetentities&ids=Q1|Q2&props=claims|sitelinks&sitefilter=enwiki|ptwiki&format=json`.
     - **Choose** the item whose P225 (taxon name) equals the OTT name, else the first.
     - **Extract** P18 (image filename), P141 (IUCN status QID), P846 (GBIF key) and the enwiki/ptwiki titles.
     - **Fallback** when there is no ott id (mrca nodes are never enriched) or no hit: search `haswbstatement:P846={gbif}`.
     - The Action API is used instead of WDQS: it is faster, more reliable, and works the same way for both lookups. Both lookups were verified live for `ott770315`, which resolves to Q15978631.
   - **GBIF species.** `GET https://api.gbif.org/v1/species/{gbif}` gives `authorship`, `publishedIn`, `vernacularName` and `rank`. The key comes from OTT `sourceinfo`, else Wikidata P846, else it is skipped.
   - **GBIF occurrences.** `GET https://api.gbif.org/v1/occurrence/search?taxonKey={gbif}&limit=0&facet=country&facetLimit=300&hasGeospatialIssue=false&occurrenceStatus=PRESENT` gives the total count and per-country counts. Drop countries with a count below `max(3, 0.1% of total)`.
4. **Stage B, in parallel** (depends on stage A):
   - **Wikipedia.** `GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}` gives `extract`, `description`, `thumbnail.source` and `content_urls.desktop.page`.
     - Skip it if there is no enwiki title.
     - **Ancestor fallback:** if the node has no article, try up to 3 nearest named ancestors of rank genus, family or order. Each needs a Wikidata lookup by its ott id, plus the summary; use cached results when they exist. Show the result labelled "About the genus *Panthera*".
   - **Image licence (Commons).** For P18, call `https://commons.wikimedia.org/w/api.php?action=query&titles=File:{f}&prop=imageinfo&iiprop=extmetadata|url&iiurlwidth=640&iiextmetadatafilter=LicenseShortName|Artist|LicenseUrl&format=json`.
     - `Artist` is HTML: strip it to text.
   - **iNaturalist photo**, only if there is no P18. `GET https://api.inaturalist.org/v1/taxa?q={name}&per_page=5`.
     - Pick the result whose `name` matches exactly.
     - Use `default_photo` only if `license_code ∈ {cc0, cc-by, cc-by-sa, cc-by-nc}`; never use a null licence.
     - Keep `medium_url`, `attribution` and `license_code`.
   - **IUCN fallback**, only if there is no P141 and rank is species. Call `https://api.gbif.org/v2/species/match?scientificName={name}` and read `additionalStatus[datasetAlias=IUCN].statusCode`.
5. **Assemble and store.** Build the document, store it with `complete = all calls succeeded or returned a definite "none"`, and return it. Partial results are fine.

### 6.2 Etiquette and limits
- **User-Agent:** `CircleOfLife/0.1 (+{SPECIES_PUBLIC_URL}; {SPECIES_CONTACT})`. Both values come from env vars, are never hard-coded, and are required at serve start.
  - Wikimedia returns 403 to generic UAs.
- **One `tokio::sync::Semaphore` per host family:**
  - GBIF: 8
  - Wikimedia (Wikidata, Wikipedia, Commons): 4
  - iNat: 1, plus a minimum 1 s gap tracked with an `Instant` in a `Mutex`
- **Retries:** honour `429`/`503` `Retry-After` by failing fast (`complete=0`) instead of sleeping in the request path.
- **No bulk pre-ingest.** A `species warm --top N` subcommand is a possible later addition and is out of scope.
- **Tests run without the network.** Each upstream base URL lives in a `Endpoints` struct inside config, which tests point at a tiny local axum mock server, or bypass by testing the parse functions on JSON fixtures.

### 6.3 `/about` document
```json
{"taxonomy":{"authorship":"Linnaeus, 1758","publishedIn":"Syst. Nat. ed. 10","source":"GBIF"},
 "summary":{"text":"…","url":"https://en.wikipedia.org/wiki/Human","about":null,"license":"CC BY-SA 4.0"},
 "image":{"url":"…","width":640,"credit":"Jane Doe","license":"CC BY-SA 4.0","licenseUrl":"…","source":"Wikimedia Commons","pageUrl":"…","about":null},
 "status":{"code":"LC","source":"Wikidata"},
 "distribution":{"occurrences":1234,"countries":[["BR",120],["US",80]],"gbifKey":2436436},
 "generated":"Homo sapiens Linnaeus, 1758 is a species in the family Hominidae, with 1,234 GBIF occurrence records from 54 countries.",
 "links":{"gbif":"…","wikidata":"…","inat":"…","opentree":"https://tree.opentreeoflife.org/opentree/argus/opentree16.1@ott770315"},
 "fetchedAt":1761600000}
```
- **`about`:** set when the text or image comes from an ancestor, for example `{"nodeId":"ott…","name":"Panthera","rank":"genus"}`.
- **`generated`:** always present, and shown only when there is no summary.
- **IUCN mapping:** P141 QIDs map to codes through a small `match`. Verify each QID once against Wikidata during P10, using a fixture:
  - LC Q211005
  - NT Q719675
  - VU Q278113
  - EN Q11394
  - CR Q219127
  - EW Q239509
  - EX Q237350
  - DD Q3245245
- **GBIF density map:** the client builds tile URLs directly, with no proxy: `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey={k}&style=…`. Hide the map if `occurrences == 0`.

---

## 7. Frontend (`web/`)

### 7.1 Modules
```
web/src/
  main.ts            bootstrap: fonts ready → meta → renderer → input → url → ui; sets window.__renderIdle
  api.ts             typed fetch wrappers (+ AbortSignal)
  types.ts           payload types
  angle.ts           u32 helpers: toRad, wrapDiff, sectorOf(level), widen
  camera.ts          double-precision camera, screen↔world↔polar, uniforms (hi/lo split), auto-orient
  input.ts           pointer/wheel/pinch/keys → camera; inertia; double-click zoom
  flyto.ts           van Wijk–Nuij interpolation (ρ = 1.4), skippable
  lod.ts             λ, V, visible angular range, wanted tile keys
  tiles/decode.ts    zero-copy decoder (typed-array views at offsets)
  tiles/cache.ts     fetch queue (level asc, then distance to centre), AbortController, LRU (≤ 400 tiles), GL buffer lifecycle
  gl/context.ts      context creation, program compile/link helpers, fullscreen triangle
  gl/renderer.ts     frame loop (render on demand), passes, blending
  gl/shaders/*.glsl  branches.vert, arcs.vert, marks.vert, marks.frag, line.frag, rim.frag, path.vert
  palette.ts         OKLCH → linear sRGB; builds the 2048×1 angle→colour LUT from meta.runs
  labels.ts          Canvas2D overlay: tip labels, clade arc labels, group labels, "You are here"
  picking.ts         CPU hit testing over loaded tiles (doubles)
  hover.ts           root→node path from loaded tiles' parent ids
  url.ts             deep-link parse/serialise
  ui/hud.ts          wordmark, bottom readout + breadcrumb, zoom buttons, kingdom key
  ui/search.ts       ⌘K / "/" palette, WAI-ARIA combobox
  ui/panel.ts        right panel / mobile bottom sheet; core + about sections
  ui/credits.ts      Data & credits dialog
  styles.css         tokens from DESIGN.md
  *.test.ts          vitest
```
**Render on demand:** a frame is requested only when the camera, tiles, hover, animation or fades change. That saves battery and makes `__renderIdle` meaningful.

### 7.2 Precision: camera-relative polar rendering
At max zoom (about 48 px between tips) the rim circumference is about 115M px. Float32 world coordinates would jitter by several pixels, so:

- **Camera state** lives in JS doubles: `camAngle` (radians, double), `camR` (world radius of the screen centre), `scale` (px per world unit) and `rotation`.
- **Per frame**, convert it to uniforms:
  - `uCamA` as a `uint` (the angle as u32)
  - `uCamR` as a hi/lo float pair (`hi = Math.fround(camR); lo = camR − hi`)
  - `uScale`
  - `uRot`
- **In the shader, for a node at `(a: uint, r: float)`:**
  ```glsl
  float dth = float(int(a - uCamA)) * TAU_OVER_2_32;   // exact uint wrap, small int → float
  float s   = sin(0.5 * dth);
  float x   = ((r - uCamR.x) - uCamR.y) - r * 2.0 * s * s;  // = r·cosΔθ − camR without cancellation
  float y   = r * sin(dth);
  // rotate (x,y) by -uRot, scale by uScale → clip space
  ```
  Use `r·cosΔθ − R` rewritten as `(r−R) − 2r·sin²(Δθ/2)`. That avoids the catastrophic cancellation of the naive form, which plan v1 had.
- Node radii are stored as f32 and so are quantised to at most 1 px at max zoom. They are static, so that does not jitter. Tips are exactly 1.0.
- **P5 acceptance includes a precision test page,** `?debug=precision`, which pans at max zoom. It must show no visible jitter.

### 7.3 Draw passes, in order per frame
All draws use the same per-tile VAO. Blending is additive (`ONE, ONE`) on a black canvas, premultiplied in the shader.

1. **Branches** (`LINES`, 2 vertices per instance, `gl_VertexID` picks the end). The segment runs from `parent_r` to `r`, or to 1.0 for frontier nodes.
   - **Colour:** `mix(branchGrey, lut(θ), smoothstep(0.55, 1.0, r))`. This matches the grey-interior, coloured-near-rim look of 4.png.
   - **Alpha:** about 0.35 × the fade. Hairlines are 1 device pixel.
2. **Arcs** (`LINES`, `2K` vertices per instance; `instanceCount = internal_count`).
   - The shader clamps the arc to the visible angular window passed as uniforms, then subdivides it.
   - `K = 128` for tile levels ≤ 3 and `K = 16` otherwise. The chord sag is then under 0.2 px at overview and negligible at deep zoom.
3. **Rim ring** (fullscreen triangle). An analytic glow around r = 1: `lut(θ) · (core·exp(−(δ/σ1)²) + halo·exp(−δ/σ2))`, where δ is the pixel distance to the rim. It fades out as tips become resolvable (λ > 12).
4. **Rim marks** (instanced quads, `TRIANGLE_STRIP` 4 vertices) for frontier nodes and tips. The fragment shader gives soft edges, `exp` across the width, so each mark has a crisp core and a halo without any blur pass.
   - **Clade spike:** outward from r = 1. Length is `clamp(3 + 2·log2(leaf_count), 3, 14)` px, width is the node's angular span in px (at least 1 px), and alpha falls off outward.
   - **Tip bar** (λ ≥ 12): inward from r = 1. Length is `min(terminal length, 120 px)`, width is `clamp(0.7·tipSpacingPx, 1, 18)` px, and the colour is `lut(θ)`.
     - The home tip (Homo sapiens) is white. It also gets a long outward bar past its label, as in 1.png.
5. **Path overlay.** A small dynamic quad buffer (2 px). It draws the hover path (root → node, text-1 at 60%) and the selection path (white), from lineage geometry. A thin ring marks the selected node.

**Fades:** alpha × `smoothstep(level, level+0.6, λ)`. Frontier extension and spikes fade out as `child_level` fades in.

**As built in P6** (constants in `web/src/style.ts`, see DESIGN.md §5): the rim ring is an annulus (140 px inside, 48 px outside) rather than a fullscreen triangle, so only pixels near the rim are shaded, and it adds hashed outward "fur". Rim marks use an exact pixel-offset variant of the polar transform. Frontier fans (P5's `tiles/fans.ts`, drawn before branches) are shaded as hashed strands that build up towards the rim, and fans under 1.5 px wide are skipped, because thousands of 1 px slivers cost more than everything else. Frame time on the dev machine's AMD iGPU: about 3.5–4.2 ms at overview, at most ~6 ms at mid zoom.

**Intro (the one signature moment):** `uReveal` clips everything with `r > uReveal`. It animates 0 → 1.05 over 900 ms with `cubic-bezier(0.2,0,0,1)`, then labels and HUD fade in over 200 ms. It is skipped under `prefers-reduced-motion` and when `?shot` is set.

**Bloom is not in v1.** The analytic glow above is the plan. Only if the visual QA rounds show the rim clearly lacks luminance does P13 add a half-float bloom, with an RGBA8 fallback. `EXT_color_buffer_half_float`/`EXT_color_buffer_float` are available on modern iOS Safari (web3dsurvey, MDN: Safari 15+), but float *blending* is patchy, so that is not a v1 risk.

### 7.4 Colour
- `palette.ts` holds the OKLCH ramps from DESIGN.md as numbers and converts them to sRGB.
- **As rebuilt after the P7 review** (the first version was a 2048×1 LUT texture blended over ±0.4% of the circle; Archaea, 0.087% of the circle, was under 2 texels and averaged away, and the circular hue mean ran seams through a third kingdom's hue):
  - colour is computed analytically from `meta.runs`, in the shaders (`palette.glsl`, runs and colours as uniform arrays) and on the CPU (`RunPalette.colourAt`, for label colours) with the same formula;
  - a run spans from half a tip slot before its first tip to half a slot after its last, and maps `t ∈ [0,1]` to its group's ramp, so every angle gets exactly its own group's colour;
  - neighbouring runs meet in a seam of `SEAM_PX` screen px, at most a quarter of the shorter run, mixed linearly in sRGB (no detour round the hue circle);
  - the rim ring computes it per fragment (its chords are far longer than a sliver like Archaea); lines, fans and marks per vertex.

### 7.5 Camera, input and auto-orient
- **Zoom** is anchored at the cursor. Wheel delta is normalised for `deltaMode` and the scale changes by `exp(−dy·0.0015)`. Pinch uses two Pointer Events.
- **Drag** pans with inertia (critically damped, about 300 ms).
- **Double-click** zooms 2× at the point.
- **Zoom range:** from the whole wheel fitting the screen to a tip spacing of 48 px, about 2^15.5× in total.
- **Initial rotation** puts the midpoint of the largest Animals run at screen angle 160°, upper-left, as in 5.png.
  - Decided in P6: the data order is Bacteria, Protists, Plants, Fungi, Animals counter-clockwise from angle 0, and Animals cover 62% of the circle. So Animals fill the top-left half (about 48°–272° on screen), Fungi sit upper-right, Plants right, and Bacteria/Protists at the bottom. 5.png's "Plants upper-right, Fungi lower-left" cannot hold at the same time, because Fungi lie between Plants and Animals in our order.
- **Auto-orient (on).** When tip spacing exceeds 4 px, the rotation eases over 400 ms so that the local outward direction points to the nearer of screen −x or +x.
  - Tip labels then read horizontally, as in 1.png and 2.png.
  - Outward −x means labels are right-aligned and sit left of the bars.
  - Below the threshold, the rotation eases back to its pre-zoom value.
  - `R` toggles auto-orient off and on.
  - As built in P6 (`orient.ts`): it releases below 3 px (hysteresis), follows pans along the rim once engaged, and a deep link that loads above the threshold is oriented at once and returns to the default composition when zoomed out. The precision test turns it off. Under reduced motion it cuts.

### 7.6 Tile manager
- **Wanted set:** `lod.ts` computes the wanted keys per frame.
- **Fetching:** missing keys are fetched with at most 6 in flight, lowest level first, then nearest to the centre. Requests for keys no longer wanted are aborted.
- **On arrival:** the tile is decoded, a GL buffer and VAO are created, and a lookup `Map<id, {tile, idx}>` is updated for picking and hover.
- **Eviction:** LRU at 400 tiles. Levels ≤ 3 are never evicted. Evicting deletes the GL objects.
- **Progressive rendering:** whatever is loaded is drawn. Missing deep tiles just mean less detail, while frontier extensions keep the picture complete.

### 7.7 Labels (Canvas2D overlay, ≤ 300 per frame)
- **Tip labels.** Shown when tip spacing ≥ 11 px.
  - Font: Source Serif 4 italic for genus/species/infraspecific ranks; roman for "no rank" tips.
  - Placed just outside the rim, along the radial direction (horizontal once auto-oriented).
  - Colour is `lut(θ)` shifted toward text-1. The home tip is white.
  - No glow on text.
- **Clade labels.** Named internal nodes, drawn along their arc, glyph by glyph, in Hanken Grotesk 11–13 px, text-2.
  - Shown only when the arc in px is at least the text width + 24 px.
  - Priority is `leaf_count`. Greedy collision rejection uses screen boxes.
  - Hysteresis: show at ≥ 1.0× fit, hide below 0.85×.
  - A 150 ms opacity fade per label, keyed by node id.
- **Group labels** (Animals, Plants, Fungi, Protists, Bacteria, Archaea).
  - Placed outside the rim at each group's largest-run midpoint while the whole wheel is visible.
  - Text-2 at 13 px, with the kingdom swatch rule beside it.
  - Hidden once λ > 6.
- **"You are here".** At low zoom, a hairline leader runs from the Homo sapiens tip angle to a small text label outside the rim. It fades out once the tip itself is labelled.
- **Fonts:** wait for `document.fonts.load()` for all three faces before the first label draw. Text width is measured once per (font, string) and cached.

**As built in P7** (`labels.ts`, `labelLayout.ts`, constants in `style.ts`):
- In this tree, a named clade's arc usually sits only a few px outside its parent's arc (dozens of nested mrca levels), and near the rim no arcs are on screen at all. So a clade is labelled on its own arc only where the stem can hold the text. Otherwise it gets a **clade bar outside the rim**: a hairline arc over its tips with end ticks, and the name beyond it, as in printed phylogenies. Bars go to clades with ≥ 90% of their extent on screen that take ≤ 60% of the visible rim. At deep zoom the bars sit beyond the tip-label column and bracket genera. Bars fade in over λ 4.2–4.8 as the group labels fade out.
- A clade's tip extent is not `[arc_lo, arc_hi]`, which spans its children's midpoints. Since tile format v2 it comes straight from the tile: the angles of tips `first_tip` and `first_tip + leaf_count − 1` (§3.7). (P7 followed first and last children through the loaded tiles, which stopped short for clades like *Pan*.)
- Culling is greedy by priority (leaf count; tips 1e9; home and group labels on top). Already-shown labels count double, and hysteresis is fit ≥ 1 to show, < 0.85 to hide. Placement alternatives slide a clade name along its bar to clear the "You are here" hairline, which is a soft obstacle. The HUD's text rectangles and the home leader bar are hard obstacles.
- Genus italics come from tiles, which carry no rank: a name is italic when it is the first word of a binomial seen in a tip name.
- The home leader bar starts `HOME_LEADER_PAD_PX` past the measured "Homo sapiens" label (`FrameParams.leaderGap`). Its obstacle hides the two subspecies labels, so the white label stands alone as in 1.png.
- The breadcrumb finds the node under the reticle in the loaded tiles (`reticle.ts`, ≤ 4 Hz) and fetches its lineage from `/api/nodes/{id}`, debounced 120 ms, with the previous request aborted and answers cached. Ancestors' tiles are usually not loaded, so the lineage cannot come from tiles. Segments fly with `flyto.ts`: an eased log-zoom tween that P9 replaces through `Flight.interpolate`. "Species in view" intersects the rim circle with the screen analytically (`inview.ts`).
- Renderer: saturating additive blending (`ONE_MINUS_DST_ALPHA, ONE`, alpha counting light; canvas `alpha: true`) for fans, lines and the ring. Rim marks stay plainly additive. Dense areas now converge on their hue instead of clipping to white (the P6 white streaks). The LUT blends boundaries in OKLCH with a circular hue mean. The wheel fits at 0.86 of the half-screen, leaving room for group labels outside it.

**After the P7 review** (`docs/review-p7.md`):
- Clade extents come from tile v2's `first_tip` (§3.7). Group labels and clade bars switch on how much of the rim is on screen (whole-wheel mode, with hysteresis), not on λ, and each family fades over 150 ms, so nothing rests half faded. Nested bars stack outward in lanes; at deep zoom bar names are horizontal. Bars are clipped to the gutter and the HUD band.
- Names are set in runs (`names.ts`): italic Latin, roman markers and informal parts, used by labels and the breadcrumb, and ready for the panel and search.
- The HUD is flat DOM; `ui/obstacles.ts` holds every screen area the canvas respects (labels keep clear; the renderer darkens the tree behind it with a soft-edged plate, `dim.vert/frag`). P8's panel and P9's search register there too; search's 50% dim is one more darkened rectangle.
- The rim's inner halo has its tail subtracted at the annulus edge (no straight-edged step). Fans fade out over λ 12.5–13.5. Homo sapiens' subspecies draw as one white bar on its row.

**As built in P8** (picking, hover, panel core, deep links; see §7.8, §7.10, §7.11):
- `picking.ts` hits what is drawn (tiles ≤ V) in doubles: in the rim zone (inside to the tip bars, outside past the spikes or, once tips are labelled, over the label column) the nearest tip by binary search in each tile's tip run, else the deepest frontier clade whose tips contain θ; elsewhere the nearest radial segment (run on to the rim while the children are not drawn) or arc within 4 px (12 px for touch), ties to the deeper node. Homo sapiens' two subspecies, drawn as one bar, pick Homo sapiens.
- `path.ts` turns a lineage into arc + radial segments; `hover.ts` draws the partial path from the tiles' parent links at once and completes it to the root from `/api/nodes` after 90 ms (answers shared through `nodes.ts`, which the breadcrumb uses too). The hover path follows what is drawn, so a frontier node's path runs on to the rim. Paths (`path.vert/frag`) and the selection ring (`ring.vert/frag`) are opaque quads through the precise polar transform, drawn after a full-screen dim (the existing dim pass); "60%" scales the grey's brightness, since a translucent or MAX-blended grey vanishes over bright bars.
- `ui/panel.ts` (core only; `.panel-about` is the empty P10 slot), `selection.ts` (click/tap selects and flies, leaving room for the panel: `insetPose`; tip-level poses move outward by 20% of the screen so the label column fits), `nav.ts` (↑/Backspace parent, ↓ largest child, ←/→ siblings in the panel's largest-first order, wrapping; only the 50 listed siblings are reachable in a polytomy), `url.ts` (`n` pushed per selection, `v` replaced 300 ms after the camera settles; Back/Forward fly to that entry's `v`).
- An mrca node is titled "Unnamed clade", "within X", plus "Common ancestor of A and B" from the two OTT ids in its node id (their names fetched), falling back to its two largest named children.
- **§7.12 addition: backing-store cap.** The tree canvas holds at most `MAX_BACKING_PX` = 6 Mpx (`gl/context.ts` `treeDpr`, never below DPR 1); larger canvases render the tree at a lower effective DPR, the label overlay keeps the full DPR. 5K overview (2560×1440 CSS at DPR 2) on the dev iGPU: uncapped 14.7 Mpx 10.7–12.8 ms, 8.3 Mpx 8.5–9.5 ms, 7 Mpx 7.6–8.4 ms, 6 Mpx 7.0–7.9 ms.
- **Precision test:** the HUD's dim plates are fixed to the screen, so the pan slid tip bars under their soft edges and skewed the centroid measurement (max 1.12 px, at the breadcrumb plate). The test now renders without them (`scene.dimsOn`): max 0.215 px on the GPU, 0.33 px on SwiftShader.

**As built in P9** (search palette and fly-to; see §5.2, §7.9, §7.10):
- **Search API.** A result's `lineage` is the 3 nearest *named* ancestors above genus (any rank, named "no rank" included; genus-and-below ranks, the root and OTT placeholders such as `h2007-1`, "… incertae sedis", "unclassified …" skipped), broadest first: Homo sapiens → Simiiformes › Catarrhini › Homininae (Primates is "no rank" and synth has no Hominidae node, so the old phylum/class/order/family rule gave Chordata, Mammalia). Queries of 2 characters match whole words only (`"ox"`, not `"ox"*`): a 2-letter prefix hits ~27k names that bm25 must score (~30 ms warm, up to 1 s cold) for arbitrary results, and ordering them by leaf count costs as much; whole words stay under 2 ms and still find "Aa". A malformed `limit` is a JSON 400 (`Result<Query<…>, QueryRejection>`). Note: *Quercus* and Fagaceae are broken taxa in synth 16.1 (no node), so "quercus" lists oak species, not the genus.
- **Fly-to** (`flyto.ts`): van Wijk–Nuij with ρ = 1.4 on the world centre and scale (view width = shorter viewport side / scale; r_i = −asinh(b_i) for precision on deep zooms), s eased by smoothstep, duration clamp(S·600, 600, 2000) ms. Rotation is eased separately: `AutoOrient.rotationFor(pose)` predicts the rotation at arrival (horizontal where auto-orient will be engaged, else the base rotation), the flight turns there by smoothstep, and auto-orient does not step while flying; `flightEnd` (landing, cancel or cut) re-engages or eases back from wherever the flight stopped. Reduced motion: a cut plus a 120 ms crossfade of a snapshot of both canvases (`crossfade.ts`; the old view is re-rendered first, since the WebGL buffer is only readable in the task that drew it).
- **Palette** (`ui/search.ts`): trigger "Search 2.3M species /" in the top-right slot; "/", ⌘K / Ctrl+K open it. WAI-ARIA combobox (input `role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; listbox of options with `aria-selected`), focus kept in the input (Tab stays), ↑/↓ wrap, PageUp/PageDown first/last, Enter chooses (pressed before the answer arrives, it takes the first result once it does), Esc closes and returns focus. 120 ms debounce, previous request aborted, answers cached per query; the active result's node is prefetched so choosing starts the flight at once. Rows: swatch (white for home), name runs with matched word prefixes at 600, rank in text-2 (omitted for species), lineage in text-3; two lines below 720 px. The tree dims to 50% through an obstacle plate, the label overlay through its opacity. Empty state only from 3 characters.
- **Evidence** (`screens/p9/`, AMD iGPU via `--use-angle=gl`, 1440×900): "homo sapiens" + Enter from the overview lands on the white home tip in 2.0 s (flight 1997 ms, Enter→landed 2017–2035 ms), tiles resident 15 → 65 during the dive. Frame time (CPU + GPU, synced) during the flight: warm p50 4.8 / p90 8.1 / max 10.5 ms with no dropped frame; cold (first visit to levels 4–13, shader warm-up) p50 5.4 / p90 9.6 / max 29 ms, slow frames at λ 3.4–5.2 where tiles arrive.

---

## P10 as built (2026-10-28)
- **Files:** `src/enrich/{mod,wikidata,wikipedia,gbif,inat}.rs`, `src/server/about.rs`, `src/db/{cache.rs,cache.sql}`, `Endpoints` + `user_agent()` in `config.rs`; `web/src/ui/{about,occmap,credits}.ts` (+ tests), panel/selection/main wiring; `tests/enrich.rs` with fixtures in `tests/fixtures/enrich/` (captured live 2026-10-28; Wikidata entity files trimmed to the read properties).
- **User-Agent:** `species-circle/<version> (+SPECIES_PUBLIC_URL; SPECIES_CONTACT)`. Both optional: without them the UA says "Circle of Life tree viewer, local development" and the server logs one warning at start (deviation from §6.2 "required").
- **Document** (§6.3) adds `nodeId`, `commonNames`, `summary.title/description`, `image.height`, `distribution.countryTotal/bbox`, `links.wikipedia/wikipediaPt/iucn`, `failed`, `complete`. `failed` lists sources that failed; the panel shows "Couldn’t reach X. Retry", and `?retry=1` refetches a cached *partial* document only.
- **Cache:** 30 d complete / 1 d partial; stale rows are served and refreshed in a background task (one per node). Partial responses are `Cache-Control: no-store`. mrca nodes get a minimal, uncached document and the panel shows no about section for them.
- **Timeouts:** 4 s per call, except GBIF's faceted occurrence search at 10 s (`SLOW_TIMEOUT`): cold queries took 5–20 s in testing, then < 1 s once GBIF cached them.
- **Generated sentence** uses GBIF's `rank` and `family` when the synth lineage lacks them (Hominidae, Staphylinidae, Latimeriidae are not nodes in synth 16.1).
- **IUCN QIDs** in §6.3 verified live against Wikidata labels (fixture `wd_iucn_statuses.json`, test `iucn_map_matches_the_live_labels`). Homo sapiens currently has no P141 and GBIF reports NE, so it shows no status.
- **Map:** GBIF density tiles (`purpleYellow.poly`, hex bins, CSS grayscale) over GBIF's own `gbif-dark` OpenMapTiles base map, 512 px tiles, no map library. Credit: GBIF.org, OpenMapTiles, OpenStreetMap.
- **Credits:** the wordmark is now a menu button ("Data & credits" only so far); the panel footer links the dialog too.

## P11 as built (2026-10-28)
- **Files:** `src/vernacular.rs` (new), `src/ingest.rs` (GBIF key → node map, report), `src/db/{mod.rs,schema.sql,queries.rs}`, `src/config.rs` (help text), `Makefile` (`fetch-gbif` resumable via `.part` + `curl -C -`; `ingest` adds `--vernacular data/raw/backbone.zip` when the file exists; `ingest-mini` uses `tests/fixtures/mini_vernacular.tsv`), `web/src/{types.ts,ui/search.ts,ui/panel.ts,styles.css}`, `web/scripts/shot.ts` (states `search-jaguar`, `search-onca`, `search-human`, `mobile-search-onca`). Tests: `tests/fixtures/{vernacular,mini_vernacular}.tsv`, unit tests in `vernacular.rs` and `queries.rs`, `tests/ingest.rs`, `tests/api.rs` (`common_names_are_found_in_english_and_portuguese`).
- **Reading:** a `.zip` path spawns `unzip -p backbone.zip VernacularName.tsv` and reads its stdout (no new crate, inflating runs on another core; `unzip` is an ingest-time tool only); `-` reads stdin, anything else is a plain TSV. Columns are found by header name (`taxonID`, `vernacularName`, `language`). Languages accept 2/3-letter codes and region suffixes (`en`, `eng`, `pt`, `por`, `pt-BR`). 190k GBIF rows have an empty language and are dropped.
- **Join and clean-up:** GBIF key → pre-order id through the first `gbif:` id in OTT `sourceinfo` (2,180,072 nodes have one; a key shared by two nodes goes to the first in pre-order). Names are trimmed and space-collapsed, then deduplicated per node + language on a fold (lowercase, Latin accents removed, punctuation → space, so "Onça-pintada" = "onca pintada"); names equal to the node's scientific name are dropped. The kept spelling prefers accents, then the most frequent spelling; `support` (rows agreeing) orders a node's names.
- **Schema additions:** `nodes.common_name` (best English, else Portuguese) and `nodes.vernacular_rows` (GBIF common-name rows for the node in *any* language: a fame proxy). `names_fts` rows with `kind=1`, `lang` 'en'/'pt'. Tiles and `dataVersion` are unchanged.
- **Search (§5.2 changes):** the query and each matched name are folded the same way before the exact (+100) and prefix (+20) tests, so "onca"/"onça" equal GBIF's "Onca". New term `+3·log10(vernacular_rows+1)` (well-known taxa first). For prefix queries a whole-word FTS pass runs first and the prefix pass is added after (64 + 64 candidates): "cat"* matches 10k names and bm25's top 64 missed the plain "Cat". Hits add `matchedLang` and `commonName`; `/api/nodes` adds `commonName`.
- **Palette:** a common-name match renders "Jaguar · *Panthera onca*", the common name in the sans with `lang` set, plus a text-3 language tag when not English ("Onca pt · *Panthera onca*"). The panel shows "Common name: X" from tree.db at once; the about section's list replaces it when it has one.
- **Full ingest:** 1,500,815 rows read; 557,511 in en/pt; 89,040 not on a tree node; 218,947 duplicates. Kept: en 213,923, pt 35,601; 112,580 nodes have a name (166,203 have any GBIF row). Time 18.6 s → 24.2 s (+5.6 s: 1.3 s reading, the rest FTS inserts); tree.db 629.5 MB → 650.5 MB (+21 MB); peak RSS 801 → 878 MB.
- **Known gaps:** GBIF's Portuguese coverage is thin (35.6k names; the jaguar has only "Onca", the puma no "onça-parda"). *Quercus* is broken in synth, so "oak" tops with *Quercus palustris* (one source calls it "Oak"). OTT's secondary `gbif:` ids are not used.

### P12 as built
- **Docker:** a three-stage `Dockerfile`:
  - `node:26-slim` with `npm i -g pnpm@12.15.0`, because Node 26 no longer ships corepack.
  - `rust:1.99-slim-trixie` with build-essential, cmake and perl. Dependencies build first against a placeholder `main.rs`, so they are cached in their own layer. `rust-toolchain.toml` is not copied, so rustup does not fetch clippy and rustfmt.
  - `debian:trixie-slim` with ca-certificates and user `species` (uid 10001). `/data` is a volume; the entrypoint is `species serve --data /data --static /app/web/dist`.
  - **Size:** 37.3 MB compressed and about 105 MB unpacked (87 MB of that is the Debian base). The ≤ 80 MB target holds for the compressed size only. `gcr.io/distroless/cc-debian13` would bring the unpacked size to about 40 MB but has no shell; not done.
- **Health check:** the image's `HEALTHCHECK` is a new subcommand, `species healthcheck` (`src/healthcheck.rs`, a std `TcpStream` GET of `/healthz`), so no curl is needed. In Coolify, an image HEALTHCHECK overrides the dashboard check.
- **Compose:** `compose.yaml` mounts `./data` at `/data` and runs as `${UID:-1000}:${GID:-1000}`, so the server can write `cache.db` to a bind mount owned by the host user. A named volume inherits uid 10001 from the image.
- **Logs:** colour only on a TTY, so `docker logs` and Coolify show plain text.
- **gzip:** `CompressionLayer` skips `font/*` as well as the default image types, so woff2, png and webp go out as they are. There is a test for this.
- **No WebGL2** (`fallback.ts`, forced with `?nowebgl`):
  - `web/public/fallback.webp` is a 1080² still of the default overview (96 KB) with the DESIGN §7 sentence.
  - Search, the panel and Data & credits still work without the scene (choosing a result opens its panel).
- **Smoke test:** `web/scripts/smoke.ts` (`pnpm -C web test:e2e`, `make smoke`, which starts its own server on :3077) runs load → search "homo sapiens" → Enter → panel title "Homo sapiens" and `n=ott770315` in the URL, then the same on `?nowebgl`. It passes on tree.db, on mini.db and against the container. It is not part of `make check`.
- **Polish:**
  - **Breadcrumb:** with a selection whose rim point is on screen, the breadcrumb shows the selection's lineage instead of the reticle's; panning the selection away hands it back.
  - **Tip labels:** a tip label that would cross the screen side is set with an abbreviated genus ("D. ruscinensis", `abbreviateGenus` in names.ts) before it is dropped.
  - **Home leader:** its length is capped at the 16 px gutter (`leader.ts`, shared by the renderer and the label obstacle) and it fades out when squeezed below about 60 px.
  - **HUD dim plates:** the falloff now starts at the text box and runs over pad + soft (28 px), instead of a flat 85% padded block with a 20 px fringe that read as a blurred box behind the wordmark.
  - **Clade bars:** at most `CLADE_MAX_LANES` = 3 nested lanes. The innermost (most specific) clades stay; the broader ones are left to the breadcrumb.
  - **"in X":** the panel's "in X" is the nearest named ancestor above genus, named no-rank clades included, the same rule as the search context line (Homo sapiens → Homininae, Panthera onca → Felidae).
  - **Hover dim:** hovering also dims the label overlay to 60% (`.hovering #overlay`).
  - **Search swatches:** Homo sapiens' subspecies get the white home swatch, matching the canvas (`isHomeHit`).
  - **Image credit:** reads "Image:", not "Photo:".
- **GPU frame times** (AMD iGPU, `SHOT_GPU=1`): overview 3.5 ms, mammals 6.3 ms, deep-homo 1.3 ms, panel-homo 1.4 ms, 2560×1440@2 overview 7.8 ms, mobile 2.6 ms. All are within the 8 ms budget.
