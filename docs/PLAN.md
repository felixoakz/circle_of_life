# Circle of Life: plan and architecture

A zoomable radial tree of all ~2.39 million tips in the Open Tree of Life synthesis. You can zoom from the whole wheel down to single species, click any node for details, and search by scientific or common name.

**Companion docs.** An implementing agent needs this file, `docs/DESIGN.md` (visual system, binding for anything visual) and `CLAUDE.md` (conventions; its content is specified in §12 and written in P0). Sources and licences are in `docs/data-sources.md`, the tile bytes in `docs/tile-format.md`, and the WebGPU renderer in `docs/plan-webgpu.md` (plan) and `docs/webgpu.md` (explainer).

The sections describe the design; paragraphs marked **As built in Pn** record what a phase actually shipped where it refined or departed from the plan.

**Inspiration.** The reference frames from the inspiration video are in `docs/reference/1.png … 5.png` (copied there in P0).

- **5.png** and **4.png**: the whole wheel. Thin grey elbow branches turn the group colour near a glowing, furry rim, with a small empty ring at the centre.
- **3.png**: an "Animals" label and a "You are here" leader.
- **1.png** and **2.png**: deep zoom, auto-oriented to horizontal. Glowing terminal bars, species names outside the rim, and *Homo sapiens* in white with a long leader bar.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Backend | Go 1.27: the standard library (`net/http`, `log/slog`, `flag`, `compress/gzip`) plus `modernc.org/sqlite`. One static binary (`CGO_ENABLED=0`) with `ingest`, `serve`, `healthcheck` and `version` subcommands. |
| Storage | SQLite. `tree.db` is immutable, rebuilt by ingest, opened read-only through a `database/sql` pool. `cache.db` is mutable and holds enrichment, through a one-connection pool. |
| Tree data | OpenTree synth **opentree16.1** `labelled_supertree.tre` plus **OTT 3.7.3** `taxonomy.tsv`. Both are CC0 and already downloaded (§2.1). |
| Dates | None exist in synth, so there are **no time rings and no Mya**. |
| Polytomies | Drawn as honest fans. The UI says "unresolved". |
| Layout | Dendrogram, leaves equally spaced on the rim. Radius `r = r0 + (1−r0)·d/(d+h)`. No gaps between groups and no collapsing of monotypic chains (measured; see §3.4). |
| LOD | Additive angular tiles (§3.6): every node is stored exactly once, at the level where its arc becomes ≥ 1/P of a sector. |
| Glow | **Analytic glow in v1**: additive blending, soft-edged quads and an analytic rim ring. No bloom FBO, no half-float, no tone mapping. Bloom is a stretch item (§9, P13). |
| Frontend | Vite 8 + TypeScript, vanilla DOM. The tree is drawn with raw WebGPU (WGSL), with a raw WebGL2 renderer as the fallback behind one interface (§7.13); a Canvas2D overlay draws the labels. |
| Enrichment | Lazy on click, cached in `cache.db` as one JSON document per node. Wikidata is looked up by OTT id (P9157), with GBIF, Wikipedia, Commons and iNaturalist behind it. |
| Common names | Phase 11, from the **GBIF Backbone `VernacularName.tsv`**, joined by the integer GBIF key that OTT `sourceinfo` already carries. Languages en + pt. |
| Visual QA | A Playwright screenshot script (`web/scripts/shot.ts`), then reviewer critique rounds against the reference frames. |
| Git | Implementing agents do **not** commit unless the user asks. |

---

## 1. Architecture

```
                    ┌──────────────── species (one Go binary) ────────────────┐
 raw data ──ingest─▶│ tree/ (parse, layout, LOD) ─▶ tiles/ ─▶ data/tree.db    │
 (OTT, synth,       │                                                         │
  GBIF vernacular)  │ serve: net/http ServeMux                                │
                    │   /api/meta, /api/v/{ver}/tiles/…  ◀── tree.db (ro)     │
 browser ◀──HTTP──▶ │   /api/search, /api/nodes/{ref}    ◀── tree.db (ro)     │
  (WebGPU/WebGL2)   │   /api/nodes/{ref}/about ─▶ enrich/ ─▶ cache.db (rw)    │
                    │   /*  static web/dist                     │             │
                    └───────────────────────────────────────────┼─────────────┘
                                                                ▼
                        Wikidata · Wikipedia · Commons · GBIF · iNaturalist
```

The work splits into an offline step and an online step.

- **Offline: `species ingest`.** Parses the tree and the taxonomy, computes the layout and the LOD levels, cuts binary tiles and writes `tree.db`. Budget: under 2 minutes and under 3 GB of RAM (as built: about 50 s and 1.2 GB peak RSS on the full data with common names).
- **Online: `species serve`.** Serves `tree.db` without computing anything per request. Tiles are pre-gzipped blobs sent with `immutable` caching. Only the `/about` endpoint touches the network, and only on a cache miss.

### 1.1 Go dependencies
One module at the repository root (`go.mod`, module path `species`, `go 1.27`), with `cmd/species` (the binary) and packages under `internal/`.

| Dependency | Version | Notes |
|---|---|---|
| `modernc.org/sqlite` | v1.61.0 | The only third-party dependency: SQLite 3.54.1 translated to pure Go, with FTS5 compiled in. No cgo, so `CGO_ENABLED=0` builds a fully static binary. `internal/db/fts5_probe_test.go` proves the FTS5 features we use (`unicode61 remove_diacritics 2`, prefix indexes, `bm25()`, `'optimize'`). |
| standard library | Go 1.27 | `net/http` (1.22+ method and wildcard patterns, `PathValue`), `database/sql`, `encoding/json`, `encoding/binary`, `compress/gzip`, `log/slog`, `flag`, `os/exec`, `embed`, `context`, `sync` (`WaitGroup.Go`), `slices`, `cmp`, `net/http/httptest` in tests. |

**Not used, on purpose:**
- `mattn/go-sqlite3`: it needs cgo and a C toolchain in the image.
- A router or web framework. `http.ServeMux` patterns cover every route (§5.1).
- A gzip middleware library. `internal/server/gzip.go` is about 100 lines with exactly the rules in §5.
- A Newick library. The parser is hand-written: about 100 lines and a good exercise.
- `encoding/csv`. TSVs are split by hand with `bytes.Cut`, since OTT's `\t|\t` separator is non-standard anyway.
- `embed` for `web/dist`. Static files are served from disk, so the frontend can be rebuilt without rebuilding the binary.
- `errgroup`. Enrichment errors go into a per-document report, never up the stack.
- Linters beyond `gofmt` and `go vet`.
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
```go
// An "arena": every node lives in one set of slices and nodes link by uint32
// index instead of pointers. Cache-friendly, almost nothing for the garbage
// collector to scan, and 2.7M nodes fit in a few hundred MB.
type Tree struct {
	Label    []Label    // ott id, mrca text, or unlabelled (the zero value)
	Parent   []uint32   // NoParent for the root
	Children [][]uint32 // nil for the 2.39M tips; ~340k internal nodes allocate
}
```
Per-node results live in plain parallel slices that a `Layout` struct owns: `LeafCount`, `Height`, `Depth`, `Group`, `Level`, and so on, all `[]uint32`, `[]float32` or `[]uint8`. Parallel slices instead of one big struct keep each step readable and pointer-free. Each step is a function from `*Tree` (plus earlier results) to new slices.

**Taxonomy memory.** Every kept name is appended to one big string, and each node stores where its name starts and ends; ranks are interned (a small index per node into a short list of rank strings); GBIF and NCBI ids are plain `[]uint32` with `NoID` for none. Lines are split with `bytes.Cut`, so the ~2M taxonomy rows that are not in the tree allocate nothing. Maps are `map[uint32]uint32` (no pointers), and output is never built by ranging over a map, whose order is random.

### 3.2 Steps
1. **Parse Newick** (`internal/tree/newick.go`). This is a byte scanner with an explicit stack and no recursion, since depth 111 is fine but the habit matters.
   - `(` pushes a new internal node.
   - `,` is a separator.
   - `)` pops, then reads the label that follows.
   - A bare token is a tip.
   - Labels are `ott\d+` or `mrcaott\d+ott\d+`. Support quoted labels and a missing label (the zero `Label`, unlabelled) only so the tests can cover them; the real file has neither.
   - Creating nodes in parse order already gives a pre-order, so the parent index is always smaller than the child index.
2. **Read the taxonomy** (`internal/tree/taxonomy.go`). Stream `taxonomy.tsv` line by line with a `bufio.Scanner`. Keep a row only if its uid is in the tree's set of OTT ids (a `map[uint32]uint32` from ott to node). Store `name`, `rank`, and the `gbif` and `ncbi` ids parsed from `sourceinfo`. The `flags` column is not kept (§2.2).
   - `mrca` nodes have no name.
   - Report a count of tree ott ids that have no taxonomy row; it should be 0.
3. **Leaf counts and heights.** Iterate node indices in **reverse**; reversed pre-order is a valid post-order. `leaf_count[p] += leaf_count[c]` and `height[p] = max(height[p], height[c] + 1)`. There is no recursion.
4. **Groups** (`internal/tree/groups.go`). This is a two-pass rule and needs no lookups by name.
   - **Tips:** walk in pre-order. `group[v]` is the group of the nearest ancestor-or-self in the root-id table (§2.2), where Eukaryota maps to Protists. Every tip ends up in exactly one group.
   - **Internal nodes:** walk in post-order. A node takes its children's group if they all agree, otherwise `MIXED = 255`. This keeps Eukaryota, Opisthokonta and the root out of every single group.
   - Fail with a clear error if any root id is missing from the tree.
5. **Ladderize.** Sort each `children` list by `(leaf_count asc, label)`, which gives the sweeping spiral of 5.png. Labels order ott ids first (ascending), then mrca text, then unlabelled (`CompareLabels`). The sort is stable (`slices.SortStableFunc`), so the same input always gives byte-identical tiles and the same `dataVersion`.
6. **Pre-order renumbering and angles.** Run one explicit-stack DFS over the sorted children. It emits nodes in their final pre-order (the new `id`), assigns `depth`, and numbers tips 0..N in visit order (`tip_rank`).
7. **Layout** (§3.3–3.5), **LOD** (§3.6), **tiles** (§3.7), **common names** (§3.8, optional), **search names** (§5.2), then write `tree.db` in one transaction with prepared statements (`journal_mode=OFF`, `synchronous=OFF` while writing, FTS `optimize` after the commit).

**Targets on the full data:** under 2 min, peak RSS under 3 GB, and `tree.db` around 0.5–0.8 GB. Print each of these. As built: about 50 s, 1.19 GB peak RSS (VmHWM), `tree.db` about 670 MB. Ingesting the same inputs twice gives identical databases (`TestIngestTwiceIsIdentical`).

### 3.3 Angles: u32 fixed point
`θ = a / 2³² · 2π`. The resolution is 1.46e-9 rad. Differences wrap correctly, because unsigned arithmetic wraps (Go's `uint32`; `>>> 0` in TypeScript), and the sector at level L is a bit shift.

- **Tip:** `angle = ((2·tip_rank + 1) · 2³¹) / N`, computed in `uint64`. Tips are evenly spaced, with no gaps between groups; the reference has none.
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
  - **Level 0:** Go defines `x >> 32` on a `uint32` as 0, but JavaScript takes shift counts mod 32, so `x >>> 32` is `x`. Both sides special-case it: `if level == 0 { return 0 }` (`tree.SectorOf`, `angle.ts` `sectorOf`). The Go side carries a `// LEARN:` comment on shift semantics.
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
           u32 parent[n]        parent pre-order id (0xFFFFFFFF for root)
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
- A **golden fixture** `tests/fixtures/golden_tile.bin` is written by a Go test from the mini tree (`TestGoldenTile`; `make golden` rewrites it) and decoded by a Vitest test, so both sides agree byte for byte.
- Tiles are gzipped at `gzip.BestCompression`. `dataVersion` hashes the raw (ungzipped) tile bytes with FNV-1a, so it depends only on the data, never on the compressor.
- **v2 (after the P7 review)** added `first_tip`. A clade's extent on the rim is exactly the angles of tips `first_tip` and `first_tip + leaf_count − 1` (§3.3), so clade bars no longer walk loaded tiles to find it, which stopped short whenever a clade's last child had an odd number of children (*Pan*).

### 3.8 Common names (P11, `internal/vernacular/`)
`--vernacular` takes the GBIF backbone (`data/raw/backbone.zip`), a plain `VernacularName.tsv`, or `-` for stdin; `--langs` defaults to `en,pt`.
- **Reading:** a `.zip` path runs `unzip -p backbone.zip VernacularName.tsv` (`os/exec`) and reads its stdout, so inflating runs on another core and nothing is unzipped to disk (`unzip` is an ingest-time tool only). Columns are found by header name (`taxonID`, `vernacularName`, `language`). Languages accept 2/3-letter codes and region suffixes (`en`, `eng`, `pt`, `por`, `pt-BR`); 190k GBIF rows have an empty language and are dropped. Text that is not UTF-8 stops the ingest.
- **Join:** GBIF key → pre-order id through the first `gbif:` id in OTT `sourceinfo` (2,180,072 nodes have one; a key shared by two nodes goes to the first in pre-order). OTT's secondary `gbif:` ids are not used.
- **Clean-up:** names are trimmed and space-collapsed, then deduplicated per node + language on a fold (`internal/names`: lowercase, Latin accents removed, punctuation → space, so "Onça-pintada" = "onca pintada"); names equal to the node's scientific name are dropped. The kept spelling prefers accents, then the most frequent spelling; `support` (rows agreeing) orders a node's names, with a stable sort.
- **Stored:** `nodes.common_name` (best English, else Portuguese), `nodes.vernacular_rows` (GBIF common-name rows for the node in *any* language: a fame proxy for search), and `names_fts` rows with `kind=1` and `lang` 'en'/'pt'. Tiles and `dataVersion` do not change.
- **Full data:** 1,500,815 rows read; 557,511 in en/pt; 89,040 not on a tree node; 218,947 duplicates. Kept: en 213,923, pt 35,601; 112,580 nodes have a name (166,203 have any GBIF row). Common names add a few seconds and about 21 MB to `tree.db`.
- **Known gaps:** GBIF's Portuguese coverage is thin (35.6k names; the jaguar has only "Onca", the puma no "onça-parda"). *Quercus* is broken in synth, so "oak" tops with *Quercus palustris* (one source calls it "Oak").

---

## 4. Database schema (`internal/db/schema.sql` and `cache.sql`, embedded with `//go:embed`)

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
  r REAL NOT NULL,                      -- the tile's float32, widened exactly
  gbif_id INTEGER, ncbi_id INTEGER,
  common_name TEXT,                     -- best English (else Portuguese) common name, P11
  vernacular_rows INTEGER NOT NULL DEFAULT 0  -- GBIF common-name rows, all languages
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
- **Connections** (`internal/db/open.go`, `cache.go`). The pragmas go in the DSN as `_pragma=…`, so every connection a `database/sql` pool opens gets them:
  - `tree.db`: `file:…?mode=ro`, `query_only(1)`, `mmap_size(1073741824)`; a normal pool, since reads are safe in parallel.
  - `cache.db`: `journal_mode(WAL)`, `synchronous(NORMAL)`, `busy_timeout(2000)`; `SetMaxOpenConns(1)`, because the cache sees a handful of writes a minute and one writer never waits on another.
  - Tests use temporary files, never `:memory:`: with `database/sql`, every pooled connection to `:memory:` is a separate empty database.

---

## 5. HTTP API (`internal/server/`)
Routes are `http.ServeMux` patterns (`GET /api/nodes/{ref}`, read with `r.PathValue`). Errors are JSON `{"error": "…"}` with a correct status code; handlers return an `httpError{status, msg}` and one adapter writes it (`errors.go`). JSON is written compactly, without HTML escaping and without a trailing newline.

**Compression** (`gzip.go`, a `func(http.Handler) http.Handler` middleware) gzips a response unless it already carries `Content-Encoding` or `Content-Range` (so tiles are never double-gzipped), the body is under 32 bytes, or the type is `image/*` (except `image/svg+xml`), `font/*`, gRPC or `text/event-stream`. Whenever compression was allowed it adds `Vary: accept-encoding`, even if this client did not accept gzip.

**Request log** (`logging.go`): one `log/slog` line per request at `info` (method, path, status, duration rounded to one decimal in its own unit). `LOG_LEVEL` picks `debug`, `info`, `warn` or `error`; anything else stops the server at start.

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
- `ref` is one of three forms, parsed by `db.ParseNodeRef` into `NodeRef{Kind, Num, Mrca}`:
  - a pre-order `id` (digits), as sent by tile clicks
  - `ott770315`
  - `mrcaott…`
- Numbers in refs, tile levels and sectors, and `limit` accept one leading `+` (`/api/nodes/+5`); `strconv.ParseUint` alone rejects it, so a small helper strips it first. Anything else that is not digits is a 400.
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

**`/*`** serves `web/dist` with `http.ServeContent` (never `http.FileServer`: no directory listings, no `/index.html` redirect) and an `index.html` fallback for deep links.
- `/assets/` (hashed names) gets `immutable` cache headers on success.
- Everything else, `index.html` included, gets `no-cache`.
- Content types are fixed in `static.go` for `.js .css .woff .woff2 .webp .svg .json`, because Go's own table depends on the system's `/etc/mime.types`. `.woff` is `application/font-woff`, which the gzip rules compress; woff2 and images go out as they are.
- `GET /api` and `GET /api/…` that match no route are a JSON 404, never `index.html` (a bare `/api` gets its own pattern, or ServeMux would redirect it to `/api/`).

### 5.2 Search
1. **Normalise the query:** trim it, then lowercase it. If it is shorter than 2 chars, return `[]`.
2. **Tokenise** on whitespace. Drop `"` characters, then build `"tok1"* AND "tok2"*`.
3. **Fetch candidates:** `SELECT node, name, kind, bm25(names_fts) … MATCH ? ORDER BY rank LIMIT 64`.
4. **Re-rank in Go** (`internal/db/search.go`), with the score as a sum:
   - exact full-name match: +100
   - name starts with the query: +20
   - scientific name (`kind=0`): +5
   - `+ 2·log10(leaf_count+1)`, so clades like "Felidae" beat obscure tips
   - `+ 1` if the tip is species rank
   - then dedupe by node and take `limit`.
5. **Goal:** "homo sap" returns Homo sapiens first, and "felidae" returns Felidae first. With P11, "human", "lion" and "onça" work too.

**As built (P9, P11):**
- **Context line.** A result's `lineage` is the 3 nearest *named* ancestors above genus (any rank, named "no rank" included; genus-and-below ranks, the root and OTT placeholders such as `h2007-1`, "… incertae sedis", "unclassified …" skipped), broadest first: Homo sapiens → Simiiformes › Catarrhini › Homininae (Primates is "no rank" and synth has no Hominidae node, so the planned phylum/class/order/family rule gave Chordata, Mammalia).
- **Two-character queries** match whole words only (`"ox"`, not `"ox"*`): a 2-letter prefix hits ~27k names that bm25 must score (~30 ms warm, up to 1 s cold) for arbitrary results; whole words stay under 2 ms and still find "Aa". Note: *Quercus* and Fagaceae are broken taxa in synth 16.1 (no node), so "quercus" lists oak species, not the genus.
- **Two passes.** For prefix queries a whole-word FTS pass runs first and the prefix pass is added after (64 + 64 candidates): "cat"* matches 10k names and bm25's top 64 missed the plain "Cat". Several names of one node keep the best-scoring one (the earlier on a tie); the final order is score, then leaf count, then id.
- **Folding.** The query and each matched name are folded the same way (`internal/names.Fold`, which follows the FTS tokenizer) before the exact (+100) and prefix (+20) tests, so "onca"/"onça" equal GBIF's "Onca". `İ` lowercases to `i` + combining dot, as in Unicode's full mapping.
- **Fame.** New term `+3·log10(vernacular_rows+1)`, so well-known taxa beat obscure ones with the same name quality. Each product in the score is wrapped in an explicit `float64(…)` conversion so the compiler cannot fuse a multiply and an add into one FMA (arm64 does), which would round differently and could swap two equal scores.
- Hits add `matchedLang` and `commonName`; `/api/nodes` adds `commonName`. An empty or too-short query answers `[]`, never `null`. A malformed `limit` is a JSON 400; `limit` is clamped to 1..50.

### 5.3 DB access in the server
`server.State` holds the `tree.db` pool (`*sql.DB`), the meta JSON and data version read at start, and, once `WithEnrichment` is called, the `cache.db` pool and the enricher. A `State` without them answers `/about` for named nodes with a 503, which keeps tests that only read the tree off the network.
- `database/sql` is already a pool that is safe for concurrent use, so handlers call queries directly, with no lock. Every query takes the request's `context.Context`, so a client that goes away cancels its query.
- Queries take tens to hundreds of microseconds; the pool runs a burst of tile reads in parallel.
- `Run` listens on `0.0.0.0:PORT` and stops on Ctrl+C or SIGTERM (`signal.NotifyContext`), then `srv.Shutdown` waits for in-flight requests.

---

## 6. Enrichment (`internal/enrich/`): lazy, cached, attributed

### 6.1 Flow for `GET /api/nodes/{ref}/about`
1. Look up the node in `tree.db` to get `node_id`, name, rank, `gbif_id`, the lineage, and the ott id if any.
2. Check the cache: if the `about` row is fresh, return it. Fresh means 30 days when `complete=1`, or 1 day when `complete=0`.
3. **Stage A, in parallel** (one goroutine per call under a `sync.WaitGroup`) with a 4 s `context.WithTimeout` each:
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
- **User-Agent:** `species-circle/<version> (+{SPECIES_PUBLIC_URL}; {SPECIES_CONTACT})`. Both values come from env vars and are never hard-coded. As built (P10) both are optional: without them the UA says "Circle of Life tree viewer, local development" and the server logs one warning at start. A public deployment must set them.
  - Wikimedia returns 403 to generic UAs.
- **One buffered channel per host family, used as a semaphore** (a send takes a slot, a receive gives it back):
  - GBIF: 8
  - Wikimedia (Wikidata, Wikipedia, Commons): 4
  - iNat: 1, plus a minimum 1 s gap (`INatGap`), kept by holding a `sync.Mutex` across the wait
- **Retries:** honour `429`/`503` `Retry-After` by failing fast (`complete=0`) instead of sleeping in the request path.
- **No bulk pre-ingest.** A `species warm --top N` subcommand is a possible later addition and is out of scope.
- **Tests run without the network.** Each upstream base URL lives in an `Endpoints` struct in `internal/config`. Tests point it at `internal/enrich/enrichtest`, an `httptest` mock that answers every service from the JSON fixtures in `tests/fixtures/enrich/` (`config.EndpointsUnder(base)` puts each service under its own path prefix), or test the parse functions on the fixtures directly.

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
- **IUCN mapping:** P141 QIDs map to codes through a small `switch`. Verify each QID once against Wikidata during P10, using a fixture:
  - LC Q211005
  - NT Q719675
  - VU Q278113
  - EN Q11394
  - CR Q219127
  - EW Q239509
  - EX Q237350
  - DD Q3245245
- **GBIF density map:** the client builds tile URLs directly, with no proxy: `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey={k}&style=…`. Hide the map if `occurrences == 0`.
- **Field order is JSON key order** for the document's Go structs, and absent values are pointers that encode as `null` (no `omitempty`: the client reads one shape with every key present). Slices are never nil, so empty lists are `[]`. A country count is a two-element array, `["BR", 120]`, through its own `MarshalJSON`/`UnmarshalJSON`.

### 6.4 As built in P10
- **Files:** `internal/enrich/{enrich,doc,html,wikidata,wikipedia,gbif,inat}.go`, `internal/server/about.go`, `internal/db/{cache.go,cache.sql}`, `Endpoints` and `UserAgent()` in `internal/config`; `web/src/ui/{about,occmap,credits}.ts` (+ tests), panel/selection/main wiring. Fixtures in `tests/fixtures/enrich/` were captured live on 2026-10-28 (Wikidata entity files trimmed to the properties we read).
- **Document** (§6.3) adds `nodeId`, `commonNames`, `summary.title/description`, `image.height`, `distribution.countryTotal/bbox`, `links.wikipedia/wikipediaPt/iucn`, `failed`, `complete`. `failed` lists sources that failed; the panel shows "Couldn’t reach X. Retry", and `?retry=1` refetches a cached *partial* document only.
- **Cache:** 30 d complete / 1 d partial; stale rows are served and refreshed in a background goroutine (one per node, detached from the request with `context.WithoutCancel`). Partial responses are `Cache-Control: no-store`. A client that disconnects mid-fetch cancels the request context; that partial document is not stored. mrca nodes get a minimal, uncached document and the panel shows no about section for them.
- **Timeouts:** 4 s per call, except GBIF's faceted occurrence search at 10 s (`SlowTimeout`): cold queries took 5–20 s in testing, then < 1 s once GBIF cached them.
- **Wikipedia titles** go into URLs as one path segment, escaped by the WHATWG path-segment rules plus `/` and `%` (`escapePathSegment`): controls, space, `"#<>?\`{}/%` and non-ASCII are percent-encoded, `()!*'` stay (Go's `url.PathEscape` would encode them).
- **Generated sentence** uses GBIF's `rank` and `family` when the synth lineage lacks them (Hominidae, Staphylinidae, Latimeriidae are not nodes in synth 16.1).
- **IUCN QIDs** in §6.3 verified live against Wikidata labels (fixture `wd_iucn_statuses.json`, test `TestIUCNMapMatchesTheLiveLabels`). Homo sapiens currently has no P141 and GBIF reports NE, so it shows no status.
- **Map:** GBIF density tiles (`purpleYellow.poly`, hex bins, CSS grayscale) over GBIF's own `gbif-dark` OpenMapTiles base map, 512 px tiles, no map library. Credit: GBIF.org, OpenMapTiles, OpenStreetMap.
- **Credits:** the wordmark is a menu button ("Data & credits"); the panel footer links the dialog too.

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
  tiles/cache.ts     fetch queue (level asc, then distance to centre), AbortController, LRU (≤ 400 tiles), GPU buffer lifecycle
  tiles/fans.ts      frontier fans (§7.3)
  scene.ts           the frame loop (render on demand) over whichever renderer won
  render/types.ts    the Renderer interface both backends implement (§7.13)
  render/plan.ts     pure frame plan: every per-draw decision, executed by both backends
  render/select.ts   backend choice (WebGPU, else WebGL2, else the fallback page)
  render/canvas.ts   backing-store size and DPR cap, shared by both backends
  render/pixels.ts   top-down RGBA readback helpers (precision test, pixel diffs)
  gpu/*.ts           WebGPU backend: device, pipelines, uniforms, tiles, timing, parity page
  gpu/shaders/*.wgsl common, palette, frag, tile, fans, lines, rim, marks, dim, path, ring, parity
  gl/context.ts      WebGL2 context creation, program compile/link helpers
  gl/renderer.ts     WebGL2 backend: executes the frame plan with GL calls
  gl/shaders/*       branches.vert, arcs.vert, marks.*, line.frag, rim.*, fans.*, path.*, ring.*, dim.*, common/palette/frag.glsl
  palette.ts         OKLCH → linear sRGB; run colours from meta.runs (§7.4)
  labels.ts          Canvas2D overlay: tip labels, clade arc labels, group labels, "You are here"
  picking.ts         CPU hit testing over loaded tiles (doubles)
  hover.ts           root→node path from loaded tiles' parent ids
  url.ts             deep-link parse/serialise
  ui/hud.ts          wordmark, bottom readout + breadcrumb, zoom buttons, kingdom key
  ui/search.ts       ⌘K / "/" palette, WAI-ARIA combobox
  ui/panel.ts        right panel / mobile bottom sheet; core + about sections
  ui/credits.ts      Data & credits dialog
  ui/about.ts        the panel's about section (§6), ui/occmap.ts the GBIF density map
  fallback.ts        the no-WebGL2/no-WebGPU page (§7.11)
  styles.css         tokens from DESIGN.md
  *.test.ts          vitest
```
**Render on demand:** a frame is requested only when the camera, tiles, hover, animation or fades change. That saves battery and makes `__renderIdle` meaningful.

The module list above is the plan; later phases added `labelLayout.ts`, `names.ts`, `nav.ts`, `nodes.ts`, `orient.ts`, `path.ts`, `reticle.ts`, `inview.ts`, `leader.ts`, `selection.ts`, `crossfade.ts`, `style.ts` (all tuning constants) and `ui/obstacles.ts`, described in the as-built notes below.

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
This section is written in WebGL2 terms, the first renderer; the WebGPU renderer executes the same passes from the same frame plan (§7.13). All draws use the same per-tile VAO. Blending is additive (`ONE, ONE`) on a black canvas, premultiplied in the shader.

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
- **§7.12 addition: backing-store cap.** The tree canvas holds at most `MAX_BACKING_PX` = 6 Mpx (`render/canvas.ts` `treeDpr`, never below DPR 1); larger canvases render the tree at a lower effective DPR, the label overlay keeps the full DPR. 5K overview (2560×1440 CSS at DPR 2) on the dev iGPU: uncapped 14.7 Mpx 10.7–12.8 ms, 8.3 Mpx 8.5–9.5 ms, 7 Mpx 7.6–8.4 ms, 6 Mpx 7.0–7.9 ms.
- **Precision test:** the HUD's dim plates are fixed to the screen, so the pan slid tip bars under their soft edges and skewed the centroid measurement (max 1.12 px, at the breadcrumb plate). The test now renders without them (`scene.dimsOn`): max 0.215 px on the GPU, 0.33 px on SwiftShader.

**As built in P9** (search palette and fly-to; see §5.2, §7.9, §7.10):
- **Search API** changes (context line, whole-word 2-character queries, JSON 400 for a bad `limit`) are in §5.2.
- **Fly-to** (`flyto.ts`): van Wijk–Nuij with ρ = 1.4 on the world centre and scale (view width = shorter viewport side / scale; r_i = −asinh(b_i) for precision on deep zooms), s eased by smoothstep, duration clamp(S·600, 600, 2000) ms. Rotation is eased separately: `AutoOrient.rotationFor(pose)` predicts the rotation at arrival (horizontal where auto-orient will be engaged, else the base rotation), the flight turns there by smoothstep, and auto-orient does not step while flying; `flightEnd` (landing, cancel or cut) re-engages or eases back from wherever the flight stopped. Reduced motion: a cut plus a 120 ms crossfade of a snapshot of both canvases (`crossfade.ts`; the old view is re-rendered first, since the WebGL buffer is only readable in the task that drew it).
- **Palette** (`ui/search.ts`): trigger "Search 2.3M species /" in the top-right slot; "/", ⌘K / Ctrl+K open it. WAI-ARIA combobox (input `role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; listbox of options with `aria-selected`), focus kept in the input (Tab stays), ↑/↓ wrap, PageUp/PageDown first/last, Enter chooses (pressed before the answer arrives, it takes the first result once it does), Esc closes and returns focus. 120 ms debounce, previous request aborted, answers cached per query; the active result's node is prefetched so choosing starts the flight at once. Rows: swatch (white for home), name runs with matched word prefixes at 600, rank in text-2 (omitted for species), lineage in text-3; two lines below 720 px. The tree dims to 50% through an obstacle plate, the label overlay through its opacity. Empty state only from 3 characters.
- **Common names in the palette (P11):** a common-name match renders "Jaguar · *Panthera onca*", the common name in the sans with `lang` set, plus a text-3 language tag when not English ("Onca pt · *Panthera onca*"). The panel shows "Common name: X" from `tree.db` at once; the about section's list replaces it when it has one.
- **Evidence** (`screens/p9/`, AMD iGPU via `--use-angle=gl`, 1440×900): "homo sapiens" + Enter from the overview lands on the white home tip in 2.0 s (flight 1997 ms, Enter→landed 2017–2035 ms), tiles resident 15 → 65 during the dive. Frame time (CPU + GPU, synced) during the flight: warm p50 4.8 / p90 8.1 / max 10.5 ms with no dropped frame; cold (first visit to levels 4–13, shader warm-up) p50 5.4 / p90 9.6 / max 29 ms, slow frames at λ 3.4–5.2 where tiles arrive.


**As built in P12** (polish and the fallback; see §7.10, §7.11):
- **Breadcrumb:** with a selection whose rim point is on screen, the breadcrumb shows the selection's lineage instead of the reticle's; panning the selection away hands it back.
- **Tip labels:** a tip label that would cross the screen side is set with an abbreviated genus ("D. ruscinensis", `abbreviateGenus` in `names.ts`) before it is dropped.
- **Home leader:** its length is capped at the 16 px gutter (`leader.ts`, shared by the renderer and the label obstacle) and it fades out when squeezed below about 60 px.
- **HUD dim plates:** the falloff starts at the text box and runs over pad + soft (28 px), instead of a flat 85% padded block with a 20 px fringe that read as a blurred box behind the wordmark.
- **Clade bars:** at most `CLADE_MAX_LANES` = 3 nested lanes. The innermost (most specific) clades stay; the broader ones are left to the breadcrumb.
- **"in X":** the panel's "in X" is the nearest named ancestor above genus, named no-rank clades included, the same rule as the search context line (Homo sapiens → Homininae, Panthera onca → Felidae).
- **Hover dim:** hovering also dims the label overlay to 60% (`.hovering #overlay`).
- **Search swatches:** Homo sapiens' subspecies get the white home swatch, matching the canvas (`isHomeHit`).
- **Image credit:** reads "Image:", not "Photo:".
- **GPU frame times** (WebGL2, AMD iGPU, `SHOT_GPU=1`): overview 3.5 ms, mammals 6.3 ms, deep-homo 1.3 ms, panel-homo 1.4 ms, 2560×1440@2 overview 7.8 ms, mobile 2.6 ms. All are within the 8 ms budget.

### 7.8 Picking and hover (CPU, doubles)
- **Pointer to polar:** convert the pointer to `(θ, r)` in doubles using the camera.
- **Tips:** binary search on angle in each loaded tile's tip run, when the pointer is within 6 px of the rim or the bar.
- **Internal nodes:** a linear scan over loaded internal nodes (≤ ~60k, under 1 ms).
  - It is a hit when the pointer is within 4 px of the radial segment or of the arc (at that node's r and inside `[arc_lo, arc_hi]`).
  - The smallest pixel distance wins.
- **Hover:**
  - draws the root→node path by walking `parent` ids through the `Map` (stopping if a parent is not loaded)
  - dims everything else to 60%
  - shows a tooltip: the name in its correct style, then the rank and "N species", muted
  - Throttled to animation frames.

### 7.9 Fly-to
- **Algorithm:** van Wijk & Nuij smooth zoom (ρ = 1.4) in Cartesian world coordinates (doubles), with rotation eased separately.
- **Duration:** `clamp(S·600 ms, 600, 2000)`. Any user input cancels it.
- **Route:** for a far target, the path naturally zooms out toward the common ancestor's scale, then dives in.
- **Used by:** search results, deep links, breadcrumb segments, the kingdom key, and "You are here" (the `H` key).
- **Reduced motion:** a cut plus a 120 ms crossfade.

### 7.10 HUD, search, panel (layout in DESIGN.md)
**HUD**
- Top-left: the wordmark.
- Top-right: a search trigger showing "Search 2.3M species" and a `/` hint.
- **Bottom-left:** a persistent readout and breadcrumb.
  - The breadcrumb is the lineage of the deepest named clade whose arc contains the view centre angle and whose level ≤ V, computed from loaded tiles and throttled to 4 Hz. Segments are clickable and fly to that clade.
  - The readout is "12,402 species in view · OpenTree 16.1" (the level is in `?debug` only). The count is exact and cheap, because tips are evenly spaced: count = visible rim angle / slot. It shows "—" when the rim is not on screen.
- Bottom-right: zoom −, +, reset, and the kingdom key (swatch + name; clicking one flies to that group).
- The chrome fades to 40% while dragging.

**Search palette (`⌘K`, `Ctrl+K` or `/`)**
- A centred modal list with no backdrop blur.
- Each row: kingdom swatch, the name in the correct style, then the muted lineage and the matched common name if any.
- Debounced at 120 ms, and stale requests are aborted.
- `↑`/`↓` move, `Enter` flies and selects, `Esc` closes.
- Empty state: "No taxon matches “x”. Try a genus or a common name."

**Panel**
- Desktop: a 380 px right panel. Below 720 px wide: a bottom sheet with snap points at 35% and 85%.
- **Core section,** immediate from `/api/nodes`:
  - the name, with a copy button
  - rank
  - lineage (clickable)
  - "N species" and "N direct descendants"
  - for a polytomy, "relationships unresolved"
  - ids in mono: OTT, GBIF, NCBI
- **About section,** loaded from `/about`:
  - image with credit
  - Wikipedia extract or the generated sentence
  - authorship
  - IUCN status as text, e.g. "Least Concern (LC)"
  - GBIF density map and top countries
  - links
  - a source/licence footer
- **Loading:** a truthful hairline progress bar, never a spinner.

**Data & credits dialog:** opened from the wordmark menu.

### 7.11 URL, keyboard, accessibility
- **URL:**
  - `?n=ott770315` selects the node and flies to it. It is set with `pushState` on select, so Back and Forward work.
  - `&v=θ,camR,log2scale,rot` restores the camera. It is updated with `replaceState`, debounced to 300 ms.
- **Screenshot params:**
  - `?shot` skips the intro and hides the cursor
  - `?reduced` forces reduced motion
  - `?debug` shows a debug HUD: CPU and GPU frame time, tiles, instances, λ, V
  - `?debug=precision` runs the max-zoom jitter test (`window.__precision`); `?renderer=webgl|webgpu`, `?nowebgl` and `?passes=…` are in §7.13
- **Keys:**
  - `/` or `⌘K` opens search
  - `Esc` closes the topmost layer
  - `+`/`-` zoom, arrow keys pan (when nothing is selected)
  - with a selection: `↑` or `Backspace` selects the parent, `↓` the largest child, `←`/`→` siblings
  - `H` is "You are here"
  - `R` toggles auto-orient
- **Accessibility:**
  - The canvas has `role="img"` with a live `aria-label`.
  - Selection is announced through an `aria-live="polite"` region.
  - Search is a WAI-ARIA combobox.
  - The panel is an `<aside>` with real headings.
  - Focus rings are visible (DESIGN.md).
  - Contrast is AA.
- **No WebGPU and no WebGL2:** show a static fallback image, `web/public/fallback.webp`, which the shot script generates in P12, plus working search and panel. As built (`fallback.ts`, forced with `?nowebgl`): a 1080² still of the default overview (96 KB) with the DESIGN §7 sentence; search, the panel and Data & credits work without the scene (choosing a result opens its panel).

### 7.12 Performance budget

| Item | Budget |
|---|---|
| JS + CSS + HTML | ≤ 60 KB gz (as built: initial JS 39.9 KB gz; each renderer is a lazy chunk) |
| Fonts (3 woff2 subsets, latin + latin-ext) | ≤ 120 KB |
| Tiles for first frame (levels 0–3, 15 tiles) | ≤ 250 KB gz |
| First frame (broadband, warm server) | ≤ 1.0 s |
| Frame time on an integrated GPU | ≤ 8 ms |
| Instances per frame | ≤ 150k |
| Draw calls per frame | ≤ 4 per tile + 3 |
| Tree canvas backing store | ≤ 6 Mpx (`MAX_BACKING_PX`; lower effective DPR above it, overlay keeps full DPR) |

### 7.13 Renderers: WebGPU first, WebGL2 fallback (as built after P12)
The plan is `docs/plan-webgpu.md` (phases W0–W6); `docs/webgpu.md` explains the code for a web developer learning WebGPU.
- **One interface, two backends.** WebGPU (raw API, WGSL, no libraries) is the primary renderer; the WebGL2 renderer of P5–P12 is the fallback. Both implement `Renderer` (`render/types.ts`) and execute the same pure frame plan (`render/plan.ts`): which tiles to skip at fade 0, how many segments an arc gets, where fans split, which paths to draw. Per-draw decisions therefore live in one place and the two cannot drift.
- **Selection** (`render/select.ts`): WebGPU on a hardware adapter, else WebGL2, else the fallback page. It runs before any `getContext`, because a canvas that gave a `webgpu` context can never give `webgl2`. `?renderer=webgl|webgpu` forces a backend (`webgpu` also accepts a software adapter); `?nowebgl` shows the fallback page; `window.__renderer` says which backend won and the harnesses assert it. Each backend is a lazy chunk, so a visit downloads only the one it uses (initial JS 39.9 KB gz).
- **WebGPU specifics:** tiles are bound as storage buffers and read by `instance_index` (vertex pulling, zero-copy upload of the tile bytes, §3.7); uniform structs are generated from TypeScript field lists (`gpu/layout.ts`), so TS is the single source of truth for the WGSL structs; per-draw uniforms sit in 256-byte slots with dynamic offsets; explicit 4× MSAA is resolved into the canvas. WGSL has no `#include`, so shader modules are concatenated in TS (structs + `common` + `palette` + `frag` + `tile` + the pass). `uReveal` uses a finite sentinel (1e4) instead of Infinity, and `sinPrecise` replaces WGSL's `sin` for tiny angles. Device loss recovers once in place, then reloads into WebGL2 with a session memo.
- **Instrumentation:** `timestamp-query` GPU frame time in the `?debug` HUD and `__bench` (`{ ms, gpuMs }`); `?passes=branches,arcs,…` draws only those passes in both backends; `?debug=parity` runs the shared WGSL functions in a compute shader and compares them with TypeScript references (`window.__gpuParity`, headless `pnpm -C web parity`).
- **Verified:** WebGL output bit-identical to the pre-WebGPU baselines; the compute parity page green on SwiftShader; WebGL vs WebGPU screenshots within threshold per pass (`make shot-parity`); `make smoke` green with and without `SMOKE_WEBGPU=1`. Real-GPU WebGPU performance and precision wait on a Vulkan driver on the dev machine (`docs/webgpu.md` §10).

---

## 8. Repository layout
```
species/
├─ CLAUDE.md                 agent conventions (§12)
├─ README.md                 what/why, quickstart, data licences & attribution, Docker and Coolify
├─ Makefile                  tasks (§10)
├─ go.mod / go.sum           module "species", go 1.27; modernc.org/sqlite
├─ .gitignore                bin/ data/ web/node_modules web/dist screens/ .env
├─ .dockerignore             the build context is sources only
├─ .env.example              SPECIES_DATA_DIR SPECIES_STATIC_DIR PORT SPECIES_CONTACT SPECIES_PUBLIC_URL LOG_LEVEL
├─ Dockerfile                node build → golang build (static) → distroless static runtime (§11)
├─ compose.yaml              prod-like local run, ./data mounted at /data
├─ cmd/species/main.go       subcommands: ingest | serve | healthcheck | version
├─ internal/
│  ├─ config/                flags + env for each subcommand, UserAgent, Endpoints (upstream base URLs)
│  ├─ tree/                  tree.go newick.go taxonomy.go groups.go layout.go lod.go
│  ├─ tiles/                 bucketing, encoder, decoder (for tests), gzip, tile flags
│  ├─ names/                 Fold and placeholder-name rules shared by db and vernacular
│  ├─ vernacular/            (P11) GBIF VernacularName reader
│  ├─ db/                    schema.sql cache.sql (go:embed), write.go, open.go, queries.go, search.go, cache.go
│  ├─ jsonfloat/             float types with the API's JSON number format ("1.0", "0.724")
│  ├─ enrich/                enrich.go doc.go html.go wikidata.go wikipedia.go gbif.go inat.go
│  ├─ enrich/enrichtest/     fixture-backed httptest mock of every upstream
│  ├─ server/                server.go (State, Router, Run), errors, static, gzip, logging, one file per route group
│  ├─ healthcheck/           `species healthcheck` for the Docker HEALTHCHECK
│  ├─ ingest/                orchestrates parse → layout → tiles → tree.db, and the report
│  └─ testutil/              fixture paths; minidb/ builds the mini tree.db for tests
├─ docs/
│  ├─ PLAN.md  DESIGN.md  data-sources.md  tile-format.md
│  ├─ plan-webgpu.md  webgpu.md    the WebGPU renderer: plan and explainer
│  ├─ review-p7.md           visual review after P7
│  └─ reference/1-5.png      inspiration frames (copied in P0)
├─ tests/fixtures/           mini.tre, mini_taxonomy.tsv, mini_vernacular.tsv, vernacular.tsv,
│                            golden_tile.bin, enrich/*.json (upstream samples); read by Go and Vitest
├─ data/                     gitignored: raw/, tree.db, cache.db, mini.db
└─ web/
   ├─ package.json  pnpm-lock.yaml  tsconfig.json  vite.config.ts (proxy /api → :3000)
   ├─ index.html
   ├─ public/fallback.webp
   ├─ scripts/               shot.ts (§10.2), smoke.ts, parity.ts (WGSL vs TS), pixeldiff.ts
   └─ src/ … (§7.1)
```
Go tests find the fixtures with `testutil.Fixture(name)` (through `runtime.Caller`), not `testdata/`, because the Vitest decoder test reads `tests/fixtures/golden_tile.bin` too.

**Mini fixture** (`tests/fixtures/mini.tre`), about 60 nodes:
- the real root id `ott93302`
- all six group roots: Metazoa, Fungi, Chloroplastida, Rhodophyta, Glaucophyta, Bacteria, Archaea, plus a protist under Eukaryota
- Homo sapiens `ott770315` under a short Mammalia chain
- one `mrcaott…` node
- one monotypic chain
- one polytomy of 8
- a matching `mini_taxonomy.tsv`, which includes the header and the trailing `\t|\t`

`make ingest-mini` builds `data/mini.db` so the frontend can be developed without the real data.

---

## 9. Phases
Each phase is sized for one fresh agent plus one review, and runs in order. The definition of done is the phase's acceptance criteria plus `make check` passing. No commits unless the user asks.

**P0. Scaffold.**
- **Work:**
  - The Go module with `cmd/species` subcommand stubs (`ingest`, `serve`) and the `internal/` package skeleton.
  - `Makefile`, `.gitignore`, `.env.example`, `CLAUDE.md` (§12), README stub.
  - The Vite TS app in `web/` with the dev proxy, Fontsource fonts imported and `styles.css` with the DESIGN.md tokens.
  - Copy the data into `data/raw/` and the reference frames into `docs/reference/`.
- **Acceptance:**
  - `make check` passes: `gofmt -l .` empty, `go vet ./...`, `go test ./...`, `tsc --noEmit`, `vitest run`.
  - `species serve --data data` answers `/healthz` with 200 and serves `web/dist`.

**P1. Parse the tree and taxonomy.** Files: `internal/tree/{tree,newick,taxonomy}.go`, the mini fixtures.
- **Acceptance:**
  - Unit tests cover: ott and mrca labels, a quoted label, an unlabelled node, a polytomy, a trailing `;`, the taxonomy header, the trailing separator, and `sourceinfo` parsing.
  - `species ingest --dry-run` on the real files prints exactly **2,725,682 nodes / 2,385,875 tips / 126,018 mrca**, the parse time (target under 20 s) and the peak RSS.

**P2. Layout, groups and LOD.** Files: `internal/tree/{layout,groups,lod}.go`.
- **Acceptance:** property tests on mini plus a random generated tree of 10k nodes (no extra dependency; a tiny LCG for randomness):
  - children's angles lie in `[arc_lo, arc_hi]` of the parent
  - tip angles are strictly increasing
  - `r` is strictly increasing from parent to child, and tips are at 1.0
  - `level(child) ≥ level(parent)`
  - span bound: `arc_hi − arc_lo < 2·W_L/P` for every node at L ≥ 1
  - every tip has a group in 0..=5
- **On the real data,** the dry run prints the group tip totals, which must equal §2.2, and the level histogram.

**P3. Tiles and the `tree.db` writer.** Files: `internal/tiles/`, `internal/db/{schema.sql,write.go}`, `internal/ingest/`, meta, FTS for scientific names, `docs/tile-format.md`.
- **Acceptance:**
  - encode → decode round-trip test
  - the golden tile is written
  - `internal/ingest/ingest_test.go` checks the mini DB:
    - node count
    - a lookup by `node_id`
    - Homo sapiens has flag `home`
    - every node appears in exactly one tile, at `(level, sectorOf(angle))`
  - the full run is under 2 min and logs the DB size, the tile count and the largest tile (it must be ≤ 120 KB gzipped, otherwise lower P to 256 and record why).

**P4. Read API.** Files: `internal/server/*` except `about.go`, `internal/db/{open,queries,search}.go`.
- **Acceptance:**
  - `internal/server/api_test.go` (`httptest`, no socket) passes: meta; a tile with the correct headers; 204 for an absent tile; 404 for a wrong version; search; node by id, by ott and by mrca; 404 JSON for an unknown node; exact JSON byte snapshots of a search hit and two nodes.
  - On the full DB:
    - "homo sap" returns ott770315 first
    - "felidae" returns Felidae first
    - p95 under 5 ms for search and node (a timing log over 200 requests is enough)

**P5. Renderer core and visual QA harness.** Files: `angle`, `camera`, `input`, `lod`, `tiles/*`, `gl/*` (branches, arcs, LUT colour), the debug HUD, `web/scripts/shot.ts`.
- **Acceptance:**
  - the full wheel renders from the mini DB and from the full DB
  - zooming from the whole wheel to single tips is smooth
  - `?debug=precision` shows no jitter at max zoom
  - stale requests are aborted (check the network panel), and the LRU stays at or under its cap
  - 60 fps on the dev laptop, per the debug HUD
  - `pnpm shot` writes `screens/overview.png` and `screens/deep-homo.png` with `__renderIdle` honoured
  - Vitest covers `angle`, `camera` round-trips, `lod`, and the golden tile decode

**P6. Glow, rim and orientation.** Files: rim ring, rim marks (spikes and tip bars), the home tip, the intro reveal, auto-orient, the initial rotation.
- **Acceptance:**
  - Visual QA round 1 (§10.2): the overview resembles 5.png (colour wheel, grey interior, coloured furry rim) and the deep zoom resembles 1.png (horizontal, glowing bars, home in white)
  - reduced motion is respected
  - frame time stays ≤ 8 ms

**P7. Labels and HUD.** Files: `labels.ts`, `ui/hud.ts`.
- **Acceptance:**
  - At overview: group labels and "You are here".
  - At mid zoom: clade arc labels without overlap and without flicker while slowly zooming.
  - At deep zoom: italic tip labels.
  - The bottom breadcrumb updates while panning, and its segments fly.
  - The species-in-view count is correct at deep zoom (compare against visible tip labels).
  - Visual QA round 2 (`docs/review-p7.md`).

**P8. Picking, hover, panel core and deep links.** Files: `picking.ts`, `hover.ts`, `ui/panel.ts` (core only), `url.ts`, keyboard navigation.
- **Acceptance:**
  - Hovering and clicking a tip, a named clade and an mrca node show the correct node, and the hover path reaches the root.
  - Reloading `?n=…&v=…` restores the selection and the view.
  - Back and Forward step through selections.
  - Keyboard tree navigation works, with an `aria-live` announcement.
  - Mobile bottom sheet at 390×844 (screenshot).

**P9. Search palette and fly-to.** Files: `ui/search.ts`, `flyto.ts`.
- **Acceptance:**
  - From the overview, typing "homo sapiens" and pressing Enter flies to the white home tip in ≤ 2 s, with tiles loading progressively.
  - Any input cancels the flight.
  - The combobox passes the ARIA basics: role, `aria-expanded`, `aria-activedescendant`.
  - Vitest checks the flyto endpoints and monotone progress.

**P10. Enrichment.** Files: `internal/enrich/*`, `internal/server/about.go`, `internal/db/cache.go`, the panel about-section, the credits dialog.
- **Acceptance:**
  - Parse tests run on stored JSON fixtures, with no network in tests.
  - A mock-server test proves that a cache hit makes zero upstream calls and that a timeout yields `complete=0` and a partial document.
  - The licence filter drops an all-rights-reserved iNat photo.
  - The UA contains the contact.
  - Live manual check on Homo sapiens, *Panthera onca* and an obscure beetle; the beetle gets the generated sentence plus the ancestor article label.

**P11. Common names (en + pt).** Files: `make fetch-gbif`, `internal/vernacular/`, `internal/names/`.
- **Work:**
  - Stream `VernacularName.tsv` out of `backbone.zip` without unzipping to disk (`unzip -p` through `os/exec`, §3.8).
  - Keep only rows with language `en`/`eng`/`pt`/`por`.
  - Map the GBIF `taxonID` to nodes through the gbif ids parsed from `sourceinfo`.
  - Insert the names into `names_fts` with `kind=1`.
- **Acceptance:**
  - "human", "lion", "jaguar" and "onça" find the right species.
  - Ingest time rises by ≤ 90 s.

**P12. Ship.** Files: Dockerfile, compose, README deploy notes, `fallback.webp`, Playwright smoke test (load → search → panel).
- **Acceptance:**
  - The image is ≤ 80 MB without data.
  - The container serves the app with `/data` mounted.
  - Cache headers survive Traefik.
  - Final visual QA round on desktop and mobile.
  - The DESIGN.md ship-gate checklist is all green.

**WebGPU renderer (W0–W6).** WebGPU as the primary renderer behind one interface with WebGL2 as the fallback, a pixel-diff harness, and a compute parity page. Phases and acceptance are in `docs/plan-webgpu.md`; the result is §7.13.

**P13. Stretch (only if the user asks):**
- half-float bloom
- "rim lens": a zoom-dependent compression of the distance from the rim, to show near-tip elbows at deep zoom as in 2.png
- compare-two-species mode (highlight both paths to the MRCA)
- `species warm --top N`
- a pt-BR UI

---

## 10. Development workflow

### 10.1 Makefile
`just` is not installed, so tasks are plain Make targets (`make help` lists them). The Makefile reads an optional `.env`.

| Target | What it does |
|---|---|
| `fetch-data` | curl + tar the synth tree and OTT into `data/raw/` (the URLs are in §2.1) |
| `fetch-gbif` | backbone.zip into `data/raw/` (P11), resumable through a `.part` file |
| `bin` | `CGO_ENABLED=0 go build -o bin/species ./cmd/species` |
| `ingest` | `bin/species ingest --tree data/raw/labelled_supertree.tre --taxonomy data/raw/ott3.7.3/taxonomy.tsv [--vernacular data/raw/backbone.zip] --out data/tree.db` (common names when backbone.zip is present) |
| `ingest-mini` | the same on the fixtures, writing `data/mini.db` |
| `golden` | `UPDATE_GOLDEN=1 go test ./internal/ingest -run TestGoldenTile` |
| `server` / `server-mini` | `bin/species serve --data data [--db mini.db]` |
| `web` | `pnpm -C web dev` |
| `dev` | runs both (`&` + `wait`, Ctrl+C stops both) |
| `test` | `go test ./...` + vitest |
| `check` | `gofmt -l .` empty, `go vet ./...`, `go test ./...`, `tsc --noEmit`, `vitest run` |
| `lint-design` | greps `web/src` for banned design tokens (DESIGN.md §9) |
| `shot` | `pnpm -C web shot` (needs a fresh web build and the server running) |
| `shot-parity` | WebGL vs WebGPU screenshots and pixel diffs (`SHOT_RENDERER=both`) |
| `smoke` | builds, starts its own server on `SMOKE_PORT` (3077), runs the Playwright smoke test |
| `build` | `pnpm -C web build` + `bin` |
| `docker` | `docker build -t species .` |

There is no docker-compose for development, because SQLite needs no service.

### 10.2 Visual QA loop
- **Run it with** `pnpm -C web shot [state…]` (`web/scripts/shot.ts`; Node 26 strips types natively). It shoots the server at `SHOT_BASE` (default `http://localhost:3000`, which serves `web/dist`, so build first).
- **Browser setup:** headless Chromium via Playwright. The default is SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`), so WebGL2 works without a GPU; `SHOT_GPU=1` uses the machine's GPU (`--use-angle=gl`) for real frame times. WebGPU runs add `--enable-unsafe-webgpu --enable-gpu`.
- **Per state,** it opens a URL (`?shot&n=…&v=…`), waits for `window.__renderIdle === true` (no pending tiles, no animation, fonts loaded, 2 quiet frames), and writes the PNG plus a JSON of stats (renderer, adapter, frame and GPU times, precision) next to it.
- **States:**
  - `overview`
  - `animals` (λ ≈ 5)
  - `mammals` (labels)
  - `deep-homo` (1.png zoom)
  - `panel-homo`
  - `search-open`, and since P11 `search-jaguar`, `search-onca`, `search-human`, `mobile-search-onca`
  - `mobile-overview` and `mobile-sheet` at 390×844
  - `reduced`
- **Renderers and diffs:** `SHOT_RENDERER=webgl|webgpu|both` writes into `screens/<renderer>/`; `both` or `SHOT_COMPARE=<dir>` writes heatmaps and `report.json` into `screens/diff/` and exits 1 over the thresholds (`docs/plan-webgpu.md` §5). `SHOT_QUERY='&…'` adds URL parameters, `SHOT_OUT=<dir>` moves the output.
- **Review:** after P6, P7 and P12, a separate reviewer agent compares the screens against `docs/reference/*.png` and the DESIGN.md banned-tells checklist. It writes its findings into the phase review, with 2–3 rounds at most.
- **Lint:** `make lint-design` greps `web/src/**/*.{css,ts}` for banned tokens (`backdrop-filter`, `box-shadow`, `linear-gradient`, `radial-gradient`, `border-radius:` > 4px, `Inter`, `Geist`, `JetBrains`).

### 10.3 Tests (light but real)
- **Go** (`go test ./...`, all offline):
  - parser unit tests (Newick, taxonomy, vernacular)
  - layout and LOD property tests
  - the tile codec and the FNV-1a vector
  - an FTS5 probe of the embedded SQLite
  - `internal/ingest` on the mini fixtures: the database, the golden tile, and determinism (two ingests, identical rows and tile bytes)
  - `internal/server` through `httptest`: every route, headers, gzip rules, static content types, JSON byte snapshots
  - enrichment parse functions on fixtures, plus mock-server tests (`enrichtest`) for cache hits, timeouts and the User-Agent
- **TS (Vitest):**
  - angle math
  - camera round-trips
  - lod
  - golden tile decode
  - flyto
  - palette conversion against known OKLCH→hex values from DESIGN.md
  - the frame plan, renderer selection, WGSL static checks and uniform packing (§7.13)
- **Playwright smoke test** (`make smoke`, not in `make check`): load → search "homo sapiens" → Enter → panel title "Homo sapiens" and `n=ott770315` in the URL, then the same on `?nowebgl`. `SMOKE_WEBGPU=1` requires WebGPU; `SMOKE_PORT`, `SMOKE_DATA` and `SMOKE_DB` move its server.

---

## 11. Deploy (Coolify)
The step-by-step Coolify guide is in README "Deploy to Coolify"; this section is the design.
- **Build:** the Dockerfile build pack from the git repo. Three stages (as built in P12):
  1. `node:26-slim` + `npm i -g pnpm@12.15.0` (Node 26 no longer ships corepack) → `web/dist`. Dependencies install in their own cached layer; Playwright browsers are skipped.
  2. `golang:1.27-trixie`: `go mod download` in its own cached layer, then `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`, a fully static binary (modernc's SQLite is pure Go).
  3. `gcr.io/distroless/static-debian13`: CA certificates (enrichment calls the upstreams over HTTPS), tzdata and `/etc/passwd`, nothing else; no shell, no package manager. The binary plus `web/dist`; runs as uid 10001.
  - Entry point: `species serve --data /data --static /app/web/dist`.
  - **Size:** about 7 MB compressed (what a registry stores and a server pulls) and about 19 MB unpacked, of which 12 MB is the binary; well under the 80 MB target.
- **Persistent volume** at `/data`, holding `tree.db` and `cache.db`.
  - The image ships an empty `/data` owned by uid 10001 (copied from the build stage, since there is no shell to `mkdir`), so a named volume mounted there starts out writable for `cache.db`.
  - Build `tree.db` locally (`make ingest`) and upload it with `rsync` to the volume's host path, then restart. Ingest needs about 1.2 GB of RAM plus the raw data, so it does not run on the server.
- **Env:**
  - `SPECIES_DATA_DIR=/data`, `SPECIES_STATIC_DIR=/app/web/dist`, `PORT=3000`, `LOG_LEVEL=info` (set in the image)
  - `SPECIES_CONTACT=<email or contact page>`
  - `SPECIES_PUBLIC_URL=https://<domain>`
- **Healthcheck:** the image's `HEALTHCHECK` runs `species healthcheck`, a `net/http` client with a 3 s timeout that requests `GET /healthz` on `127.0.0.1:$PORT`, so the image needs no curl. An image `HEALTHCHECK` takes precedence over a check configured in the Coolify dashboard. Traefik passes `Content-Encoding` and `Cache-Control` through unchanged; P12 verified this with `curl -I`. Leave Coolify's gzip middleware off: the app compresses its own responses.
- **Compose:** `compose.yaml` mounts `./data` at `/data` and runs as `${UID:-1000}:${GID:-1000}`, so the server can write `cache.db` to a bind mount owned by the host user.
- **Startup:** if `tree.db` is missing, `serve` exits with a clear error naming the expected path.

---

## 12. CLAUDE.md content (written in P0)
- **Project one-liner,** and a pointer to `docs/PLAN.md`, `docs/DESIGN.md`, `docs/data-sources.md`.
- **Go conventions:**
  - simple, minimal and idiomatic first, clever never; standard library first
  - `gofmt` and `go vet` clean (both in `make check`); no other linters
  - wrap errors with context using `%w`, return them, don't panic
  - `context.Context` is the first parameter of anything that does I/O or can be cancelled
  - no generics or reflection beyond what the standard library uses for you
  - no `init()` side effects and no global mutable state; pass dependencies in
  - no new dependencies without the user's approval
  - prefer plain loops and early returns over clever helpers
- **Teaching comments:**
  - every Go file starts with a header comment that says what the file does and lists "Concepts introduced here" (the package doc, `// Package x …`, lives in one file per package).
  - `// LEARN:` marks inline comments that teach a language concept (`rg "LEARN:" --type go` reads like a course). The first occurrence of each concept gets one; later ones do not repeat it.
  - Ordinary comments explain *why*.
- **TS conventions:**
  - `strict`
  - no `any`
  - modules small and single-purpose
  - DOM built with tiny helpers, no framework
- **Commands:** the `make` targets. **Data paths:** `data/raw/…`.
- **Rules:**
  - never commit unless asked
  - never hard-code the contact email
  - all visual decisions follow DESIGN.md
  - run `make check` before handing back

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Precision jitter at max zoom | Camera-relative u32 angles, hi/lo radius and the cancellation-free formula (§7.2). Tested in P5 before any polish, and again on WebGPU (`sinPrecise`, §7.13). |
| The look falls short of the reference (glow too weak without bloom) | Visual QA rounds. Tuning constants live in one `style.ts`/uniform block. Bloom is ready as P13. |
| Deep zoom shows long parallel lines rather than 2.png's elbows | This is inherent to the data (genus polytomies) and to `d/(d+h)`. It is documented, and the rim-lens stretch exists. |
| Plants appear as more than one arc (Archaeplastida is broken in synth) | Runs-based colours and labels handle multiple runs. The group label goes on the largest run. |
| Group sizes differ from the video (protists are small: 2.5%) | That is the honest data. The credits dialog explains the source. |
| Tile size skew from 12,964-tip polytomies | The tile size bound (§3.6). P3 logs the largest tile, and P is adjusted if it exceeds 120 KB gzipped. |
| Wikidata OTT → several items | The P225 == name rule, else the first. Mrca nodes are never enriched. |
| Upstream rate limits and outages | Per-host semaphores, a 4 s timeout, partial documents with a 1-day TTL, and stale cache served when a refetch fails. |
| `tree.db` (~0.7 GB) upload to Coolify | Upload once per data release with rsync. `dataVersion` busts the client caches. |
| Pure-Go SQLite speed and FTS5 behaviour | The FTS5 probe test pins the features we use; full ingest is ~50 s against a 2 min budget. Tune `cache_size` or batching only if it grows past that. |
| Ingest memory with a garbage collector | Pointer-free parallel slices and one string for all names (§3.1); peak RSS 1.19 GB against a 3 GB budget. Touch `GOMEMLIMIT` only if it passes ~2 GB. |
| TS 7 / Vite 8 tooling edges | Pin `typescript@6` if anything breaks (noted in CLAUDE.md). |
| WebGPU drivers (no Vulkan driver means software WebGPU on Linux) | A software adapter is refused by default and WebGL2 wins; `?renderer=webgpu` forces it for testing (§7.13). |

## 14. Open questions for the user
1. **Domain and contact.** The public domain name and the contact email for the upstream User-Agent (`SPECIES_PUBLIC_URL`, `SPECIES_CONTACT`). Both are optional for local development since P10; a public deployment must set them.
2. **UI language.** English UI with en+pt common-name search is the plan. Should the Wikipedia extract switch to ptwiki for `pt` browsers, which would cost a second cache key per language?
3. **Wording for tips.** About 112k tips are subspecies, varieties or unranked. The plan says "2.3M species" in the UI, with the precise breakdown in the credits dialog. Is that acceptable?
