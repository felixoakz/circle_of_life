# Circle of Life: architecture

A zoomable radial tree of all ~2.39 million tips in the Open Tree of Life synthesis. You can zoom from the whole wheel down to single species, click any node for details, and search by scientific or common name.

**Companion docs.** `docs/DESIGN.md` is the visual system (binding for anything visual). Sources and licences are in `docs/data-sources.md`, and the tile bytes in `docs/tile-format.md`. Code comments cite this file as `ARCHITECTURE §n`.

**Inspiration.** The reference frames are `docs/reference/1.png … 5.png`:
- **5.png** and **4.png**: the whole wheel. Thin grey elbow branches turn the group colour near a glowing, furry rim, with a small empty ring at the centre.
- **3.png**: an "Animals" label and a "You are here" leader.
- **1.png** and **2.png**: deep zoom, auto-oriented to horizontal. Glowing terminal bars, species names outside the rim, and *Homo sapiens* in white with a long leader bar.

---

## 1. Architecture

```
                    ┌──────────────── species (one Go binary) ────────────────┐
 raw data ──ingest─▶│ tree/ (parse, layout, LOD) ─▶ tiles/ ─▶ data/tree.db    │
 (OTT, synth,       │                                                         │
  GBIF vernacular)  │ serve: net/http ServeMux                                │
                    │   /api/meta, /api/v/{ver}/tiles/…  ◀── tree.db (ro)     │
 browser ◀──HTTP──▶ │   /api/search, /api/nodes/{ref}    ◀── tree.db (ro)     │
  (WebGL2)         │   /api/nodes/{ref}/about ─▶ enrich/ ─▶ cache.db (rw)    │
                    │   /*  static web/dist                     │             │
                    └───────────────────────────────────────────┼─────────────┘
                                                                ▼
                        Wikidata · Wikipedia · Commons · GBIF · iNaturalist
```

- **Offline: `species ingest`.** Parses the tree and the taxonomy, computes the layout and the LOD levels, cuts binary tiles and writes `tree.db`. About 50 s and 1.2 GB peak RSS on the full data with common names.
- **Online: `species serve`.** Serves `tree.db` without computing anything per request. Tiles are pre-gzipped blobs sent with `immutable` caching. Only `/about` touches the network, and only on a cache miss.
- The binary has `ingest`, `serve`, `healthcheck` and `version` subcommands. `tree.db` is immutable and opened read-only; `cache.db` is mutable and holds enrichment.

**Key decisions**
- **No dates.** Synth has none, so there are no time rings and no Mya.
- **Polytomies** are drawn as honest fans; the UI says "unresolved".
- **Layout:** a dendrogram with leaves equally spaced on the rim, radius `r = r0 + (1−r0)·d/(d+h)`, no gaps between groups, no collapsing of monotypic chains (§3.4).
- **LOD:** additive angular tiles; every node is stored exactly once (§3.6).
- **Glow is analytic:** blending, soft-edged quads and an analytic rim ring; no bloom pass, no half-float, no tone mapping.
- **Enrichment** is lazy on click, cached as one JSON document per node (§6).
- **Common names** come from the GBIF Backbone, en + pt (§3.8).

### 1.1 Go dependencies
One module at the repository root (`go.mod`, module path `species`, `go 1.27`), with `cmd/species` (the binary) and packages under `internal/`.

| Dependency | Version | Notes |
|---|---|---|
| `modernc.org/sqlite` | v1.61.0 | The only third-party dependency: SQLite 3.54.1 translated to pure Go, with FTS5 compiled in. No cgo, so `CGO_ENABLED=0` builds a fully static binary. `internal/db/fts5_probe_test.go` proves the FTS5 features we use (`unicode61 remove_diacritics 2`, prefix indexes, `bm25()`, `'optimize'`). |
| standard library | Go 1.27 | `net/http` (method and wildcard patterns, `PathValue`), `database/sql`, `encoding/json`, `encoding/binary`, `compress/gzip`, `log/slog`, `flag`, `os/exec`, `embed`, `context`, `sync` (`WaitGroup.Go`), `slices`, `cmp`, `net/http/httptest` in tests. |

**Not used, on purpose:**
- `mattn/go-sqlite3`: it needs cgo and a C toolchain in the image.
- A router or web framework. `http.ServeMux` patterns cover every route (§5.1).
- A gzip middleware library. `internal/server/gzip.go` is about 100 lines with exactly the rules in §5.
- A Newick library. The parser is hand-written, about 200 lines.
- `encoding/csv`. TSVs are split by hand with `bytes.Cut`, since OTT's `\t|\t` separator is non-standard anyway.
- `embed` for `web/dist`. Static files are served from disk, so the frontend can be rebuilt without rebuilding the binary.
- `errgroup`. Enrichment errors go into a per-document report, never up the stack.
- Linters beyond `gofmt` and `go vet`.

### 1.2 Frontend toolchain
- **Vite 8.3** (Rolldown-based) and **Vitest 5**.
- **TypeScript 7.0**, the native compiler: `tsc --noEmit` for type checking.
- **Playwright 1.64**, a dev dependency for screenshots and the smoke test.
- **Fonts** are self-hosted through Fontsource, so there are no Google requests at runtime: `@fontsource-variable/hanken-grotesk`; `@fontsource-variable/source-serif-4`, importing `wght-italic.css` only (about 52 KB latin; `opsz-italic` is 130 KB, so optical sizing is dropped to meet the font budget in §7.12); `@fontsource/spline-sans-mono`, 400 only.
- No CSS framework and no UI framework. No d3: the van Wijk–Nuij zoom is about 40 lines in `flyto.ts`.

---

## 2. Data

### 2.1 Inputs

| File | Local path | Canonical URL |
|---|---|---|
| Synth tree **opentree16.1** | `data/raw/labelled_supertree.tre` (31 MB) | `https://files.opentreeoflife.org/synthesis/opentree16.1/output/labelled_supertree/labelled_supertree.tre` |
| **OTT 3.7.3** | `data/raw/ott3.7.3/` (`taxonomy.tsv` 417 MB, `synonyms.tsv`, `forwards.tsv`, `version.txt`) | `https://files.opentreeoflife.org/ott/ott3.7.3/ott3.7.3.tgz` |
| GBIF Backbone (common names only) | `data/raw/backbone.zip` (`make fetch-gbif`) | `https://hosted-datasets.gbif.org/datasets/backbone/current/backbone.zip` (971 MB, frozen 2023-08-28) |

The tree and taxonomy are CC0. `make fetch-data` downloads them (curl + tar); ingest takes explicit `--tree` and `--taxonomy` paths. `version.txt` inside the OTT folder reads `3.7draft3`; that is expected for the 3.7.3 release.

### 2.2 Facts measured on these files

**Size and shape**
- 2,725,682 nodes in total: **2,385,875 tips** and 339,807 internal nodes.
- Every node carries a label, either `ottNNN` or `mrcaottAottB`. There are 126,018 `mrca…` nodes.
- Root `ott93302` "cellular organisms" has three children: Eukaryota, Bacteria, Archaea.

**Depth and polytomies**
- 83,305 monotypic nodes. Max depth 111.
- Homo sapiens (`ott770315`) is at depth 59, and only 2 of its ancestors are monotypic.
- Largest polytomies: 12,964, 12,378, 9,094, 8,550 and 6,428 children.

**Tip ranks:** species 2,273,995; "no rank - terminal" 78,696; subspecies 23,063; varietas 7,116; genus 1,480.

**Tips per group** (group rules in §3.2 step 4)

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
- OTT `extinct` flags are unreliable (Homo sapiens itself carries `extinct`). Extinct taxa are included like any other, and the flag is **not** carried into the layout, tile flags or the UI.
- Synth 16.1 has no node for some familiar taxa: *Quercus*, Fagaceae and Hominidae are broken, and Primates is "no rank".

---

## 3. Ingest pipeline (`species ingest`)

```
species ingest --tree data/raw/labelled_supertree.tre \
               --taxonomy data/raw/ott3.7.3/taxonomy.tsv \
               [--vernacular data/raw/backbone.zip --langs en,pt] \
               --out data/tree.db   [--dry-run]
```
Ingest writes to `tree.db.tmp`, then renames it into place atomically, so a running server is never exposed to a half-written file (it needs a restart to pick up the new one). Every step logs its timing and node counts; the run ends with the DB size, the tile count, the largest tile and the peak RSS. Ingesting the same inputs twice gives identical databases (`TestIngestTwiceIsIdentical`).

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
Per-node results live in plain parallel slices that a `Layout` struct owns: `LeafCount`, `Height`, `Depth`, `Group`, `Level`, and so on. Each step is a function from `*Tree` (plus earlier results) to new slices.

**Taxonomy memory.** Every kept name is appended to one big string, and each node stores where its name starts and ends; ranks are interned; GBIF and NCBI ids are plain `[]uint32` with `NoID` for none. Lines are split with `bytes.Cut`, so the ~2M taxonomy rows that are not in the tree allocate nothing. Maps are `map[uint32]uint32` (no pointers), and output is never built by ranging over a map, whose order is random.

### 3.2 Steps
1. **Parse Newick** (`internal/tree/newick.go`): a byte scanner with an explicit stack and no recursion. `(` pushes a new internal node, `,` separates, `)` pops and reads the label that follows, a bare token is a tip. Labels are `ott\d+` or `mrcaott\d+ott\d+`; quoted and missing labels are supported for the tests (the real file has neither). Creating nodes in parse order gives a pre-order, so a parent's index is always smaller than its children's.
2. **Read the taxonomy** (`internal/tree/taxonomy.go`). Stream `taxonomy.tsv` with a `bufio.Scanner`, keeping a row only if its uid is in the tree. Store `name`, `rank`, and the `gbif` and `ncbi` ids from `sourceinfo`. `mrca` nodes have no name. The count of tree ott ids without a taxonomy row is reported (it is 0).
3. **Leaf counts and heights.** Iterate node indices in **reverse** (reversed pre-order is a valid post-order): `leaf_count[p] += leaf_count[c]`, `height[p] = max(height[p], height[c] + 1)`.
4. **Groups** (`internal/tree/groups.go`), two passes, no lookups by name.
   - **Tips:** in pre-order, `group[v]` is the group of the nearest ancestor-or-self in the root-id table (§2.2), where Eukaryota maps to Protists.
   - **Internal nodes:** in post-order, a node takes its children's group if they all agree, otherwise `MIXED = 255`. This keeps Eukaryota, Opisthokonta and the root out of every single group.
   - Ingest fails with a clear error if any root id is missing from the tree.
5. **Ladderize.** Sort each `children` list by `(leaf_count asc, label)`, which gives the sweeping spiral of 5.png. Labels order ott ids first (ascending), then mrca text, then unlabelled (`CompareLabels`). The sort is stable, so the same input always gives byte-identical tiles and the same `dataVersion`.
6. **Pre-order renumbering.** One explicit-stack DFS over the sorted children emits nodes in their final pre-order (the new `id`), assigns `depth`, and numbers tips 0..N in visit order (`tip_rank`).
7. **Layout** (§3.3–3.5), **LOD** (§3.6), **tiles** (§3.7), **common names** (§3.8, optional), **search names** (§5.2), then write `tree.db` in one transaction with prepared statements (`journal_mode=OFF`, `synchronous=OFF` while writing, FTS `optimize` after the commit).

### 3.3 Angles: u32 fixed point
`θ = a / 2³² · 2π`. The resolution is 1.46e-9 rad. Differences wrap correctly, because unsigned arithmetic wraps (Go's `uint32`; `>>> 0` in TypeScript), and the sector at level L is a bit shift.

- **Tip:** `angle = ((2·tip_rank + 1) · 2³¹) / N`, computed in `uint64`. Tips are evenly spaced (`slot = 2³² / N`, about 1,800 units per tip), with no gaps between groups.
- **Internal node:** `arc_lo` is the first child's angle and `arc_hi` the last child's; `angle = arc_lo + (arc_hi − arc_lo) / 2`. Arcs never wrap, because the root spans `[slot/2, 2³² − slot/2]`. A monotypic node has `arc_lo == arc_hi` and draws no arc.
- **Group runs:** contiguous runs of tips with the same group, each `(group, angle_lo, angle_hi)`. A group can appear in more than one run (Plants does, because Archaeplastida is broken). They go to `meta` and drive the colours (§7.4).

### 3.4 Radius
`r(v) = r0 + (1 − r0) · d / (d + h)`, where `d` is depth from the root, `h` is height (the longest path down to a tip) and `r0 = 0.08`.

- The root sits at r0 and every tip at exactly 1.0, which gives an aligned rim.
- It is strictly increasing from parent to child: since `h_p ≥ h_c + 1`, `(d−1)/(d−1+h_p) ≤ (d−1)/(d+h_c) < d/(d+h_c)`.
- A parent at depth d with only tip children sits at `d/(d+1)`; its 12,964 children fan to the rim from there.

**Monotypic chains are not collapsed.** The Homo sapiens path has only 2 monotypic ancestors, and the longest path is not changed by collapsing. A monotypic node sits on a straight segment, which is invisible and harmless. The breadcrumb keeps every node.

**Known consequence.** The median terminal branch is 3.3% of the radius (p10 1.8%, p90 27%). At the zoom of 1.png a terminal branch is about 500k px long, so deep zoom shows parallel glowing terminal bars with labels, which matches 1.png. The dense nested elbows of 2.png are mostly not reproducible with this data, because about 93% of tips sit in genus-level polytomies.

### 3.5 What gets drawn per node
- **Radial segment:** from `(angle, parent_r)` to `(angle, r)`.
- **Arc** (internal nodes with two or more children): at radius `r`, from `arc_lo` to `arc_hi`.
- **Frontier extension.** If a node is drawn but its children are not drawn yet (`child_level > V`, §3.6), its radial segment is extended to `r = 1`. Every visible lineage then reaches the rim, so the overview looks dense.
- **Rim marks** (§7.3): a leaf gets a glowing terminal bar at deep zoom; a frontier clade gets a short outward spike at overview (the "fur").

### 3.6 Level of detail: additive angular tiles
- At level `L ∈ 0..=Lmax`, the circle is cut into `2^L` sectors of width `W_L = 2³²/2^L`. The sector of a node is `angle >> (32 − L)`.
  - **Level 0:** Go defines `x >> 32` on a `uint32` as 0, but JavaScript takes shift counts mod 32, so `x >>> 32` is `x`. Both sides special-case it (`tree.SectorOf`, `angle.ts` `sectorOf`).
- With `P = 512` (stored in meta), the **intro level** of a node is the **smallest L with `leaf_count · P · 2^L ≥ N`**, computed with an integer loop.
- `Lmax` is the smallest L with `P · 2^L ≥ N`: **Lmax = 13**, and every tip has level 13.
- Monotone: `leaf_count(parent) ≥ leaf_count(child)`, so `level(parent) ≤ level(child)`. `child_level(v)` is the minimum level over v's children, or 255 for a tip.
- **Span bound (tested).** For a node at level L ≥ 1, minimality gives `leaf_count · P · 2^(L−1) < N`, so `span < 2·W_L/P`: an arc reaches less than `W_L/P` beyond its own centre. The node is stored in the tile of the sector containing its centre, and the client widens its angular range by `W_L/P` when choosing tiles, so no branch is ever missing.
- **Continuous view level:** `λ = log2(C / (P · s))`, where C is the rim circumference in device pixels and s = 0.5 px. The integer view level is `V = clamp(floor(λ), 0, Lmax)`. Every drawn node spans at least s px; tips appear at C ≈ 2.1M px (about 0.9 px apart). Alpha per node is `smoothstep(L, L + 0.6, λ)`, so nothing pops in.
- **Which tiles to fetch:** levels `0..=V`, for sectors intersecting the visible angular range (widened by `W_L/P`). The visible range comes from the screen rectangle seen from the origin: for a convex polygon that does not contain the origin the extreme angles are at its corners; if the origin is inside, the range is the full circle.
  - **Budget rule:** with the full circle in view, fetch at most levels `0..=min(V, 6)` (≤ 127 tiles). Deep-level nodes are almost never near the centre; this is an accepted limitation.
- **Tile size:** a level-L node has `leaf_count ∈ [N/(P·2^L), 2N/(P·2^L))` and a sector holds `N/2^L` tips, so a tile holds on the order of P to 2P nodes: about 291 tips per level-13 tile, at most about 1,500 nodes and 50 KB raw. Fewer than 16,383 tiles exist; an empty tile is absent. Ingest warns if the largest tile passes 120 KB gzipped (`MaxTileGz`).
- **Per-frame load:** a 1,500 px wide view touches about 3–8 sectors per level, so about 14 levels × ≤ 8 tiles × ≤ 1,500 nodes, under 150k instances.

### 3.7 Tile binary format v2 (`docs/tile-format.md` has every offset)
All values are little-endian and every array starts 4-byte aligned. The blob is stored gzipped in `tree.db` and served with `Content-Encoding: gzip`, so the browser receives the raw bytes.

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
           u32 first_tip[n]     rank of the clade's first tip: tips are first_tip .. first_tip+leaf_count−1
           f32 r[n]
           f32 parent_r[n]
           u8  group[n]         0..5 or 255 mixed
           u8  flags[n]         bit0 tip, bit1 named, bit2 species-rank, bit3 home (Homo sapiens); bit4–7 reserved (0)
           u8  child_level[n]   255 for tips
           pad to 4
           u32 name_off[n+1]    offsets into names; empty for mrca nodes
           u8  names[names_len]
```
- Records are ordered **internal nodes first, then tips**, each run sorted by angle. The arc draw uses `instanceCount = internal_count`; picking binary-searches tips by angle.
- The client uploads **the whole ArrayBuffer once** as one WebGL2 buffer, and one VAO points each instanced attribute at its array's byte offset (u8 arrays as 1-byte attributes, which WebGL2 allows at any stride). No copies, no repacking.
- A clade's extent on the rim is exactly the angles of tips `first_tip` and `first_tip + leaf_count − 1` (§3.3). `[arc_lo, arc_hi]` is not: it spans the first and last children's midpoints, which can stop short (*Pan*).
- `id` is the internal handle and changes with every ingest; tile URLs carry the data version. Public URLs use the OpenTree node id string (§5).
- A **golden fixture** `tests/fixtures/golden_tile.bin` is written by a Go test from the mini tree (`TestGoldenTile`; `make golden` rewrites it) and decoded by Vitest, so both sides agree byte for byte.
- Tiles are gzipped at `gzip.BestCompression`. `dataVersion` hashes the raw tile bytes with FNV-1a, so it depends only on the data, never on the compressor.

### 3.8 Common names (`internal/vernacular/`)
`--vernacular` takes the GBIF backbone (`data/raw/backbone.zip`), a plain `VernacularName.tsv`, or `-` for stdin; `--langs` defaults to `en,pt`.
- **Reading:** a `.zip` path runs `unzip -p backbone.zip VernacularName.tsv` (`os/exec`) and reads its stdout, so inflating runs on another core and nothing is unzipped to disk (`unzip` is an ingest-time tool only). Columns are found by header name (`taxonID`, `vernacularName`, `language`). Languages accept 2/3-letter codes and region suffixes (`en`, `eng`, `pt`, `por`, `pt-BR`); rows with an empty language are dropped. Text that is not UTF-8 stops the ingest.
- **Join:** GBIF key → pre-order id through the first `gbif:` id in OTT `sourceinfo` (2,180,072 nodes have one; a key shared by two nodes goes to the first in pre-order).
- **Clean-up:** names are trimmed and space-collapsed, then deduplicated per node + language on a fold (`internal/names`: lowercase, Latin accents removed, punctuation → space, so "Onça-pintada" = "onca pintada"); names equal to the node's scientific name are dropped. The kept spelling prefers accents, then the most frequent spelling; `support` (rows agreeing) orders a node's names, with a stable sort.
- **Stored:** `nodes.common_name` (best English, else Portuguese), `nodes.vernacular_rows` (GBIF common-name rows in *any* language: a fame proxy for search), and `names_fts` rows with `kind=1` and `lang` 'en'/'pt'. Tiles and `dataVersion` do not change.
- **Full data:** 1,500,815 rows read; 557,511 in en/pt; 89,040 not on a tree node; 218,947 duplicates. Kept: en 213,923, pt 35,601; 112,580 nodes have a name (166,203 have any GBIF row). Common names add a few seconds and about 21 MB.
- **Known gaps:** GBIF's Portuguese coverage is thin (the jaguar has only "Onca", the puma no "onça-parda"). *Quercus* is broken in synth, so "oak" tops with *Quercus palustris*.

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
  common_name TEXT,                     -- best English (else Portuguese) common name
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
  complete   INTEGER NOT NULL,   -- 0 if any source failed/timed out
  fetched_at INTEGER NOT NULL    -- unix seconds
) WITHOUT ROWID;
```
- **One FTS table.** A plain FTS5 table, not external content and not a separate `names` table: one insert per name.
- **`node_id` is a string.** All 126k unnamed nodes already have stable, OpenTree-native ids (`mrcaott…`), which tree.opentreeoflife.org accepts. We never parse them, except to name the pair in "Common ancestor of A and B".
- **Connections** (`internal/db/open.go`, `cache.go`). The pragmas go in the DSN as `_pragma=…`, so every connection a `database/sql` pool opens gets them:
  - `tree.db`: `file:…?mode=ro`, `query_only(1)`, `mmap_size(1073741824)`; a normal pool, since reads are safe in parallel.
  - `cache.db`: `journal_mode(WAL)`, `synchronous(NORMAL)`, `busy_timeout(2000)`; `SetMaxOpenConns(1)`, because the cache sees a handful of writes a minute.
  - Tests use temporary files, never `:memory:`: with `database/sql`, every pooled connection to `:memory:` is a separate empty database.

---

## 5. HTTP API (`internal/server/`)
Routes are `http.ServeMux` patterns (`GET /api/nodes/{ref}`, read with `r.PathValue`). Errors are JSON `{"error": "…"}` with a correct status code; handlers return an `httpError{status, msg}` and one adapter writes it (`errors.go`). JSON is written compactly, without HTML escaping and without a trailing newline.

**Compression** (`gzip.go`, a `func(http.Handler) http.Handler` middleware) gzips a response unless it already carries `Content-Encoding` or `Content-Range` (so tiles are never double-gzipped), the body is under 32 bytes, or the type is `image/*` (except `image/svg+xml`), `font/*`, gRPC or `text/event-stream`. Whenever compression was allowed it adds `Vary: accept-encoding`.

**Request log** (`logging.go`): one `log/slog` line per request at `info` (method, path, status, duration). `LOG_LEVEL` picks `debug`, `info`, `warn` or `error`; anything else stops the server at start.

### 5.1 Endpoints

**`GET /healthz`** returns `200 ok`.

**`GET /api/meta`**, with `Cache-Control: no-cache`:
```json
{ "dataVersion": "otl16.1-ott3.7.3-7f3a9c",
  "tipCount": 2385875, "speciesCount": 2273995, "nodeCount": 2725682,
  "tileP": 512, "maxLevel": 13, "r0": 0.08,
  "groups": [{"id":0,"name":"Animals","rootIds":["ott691846"],"tipCount":1490245}, …],
  "runs":   [{"group":0,"angleLo":123,"angleHi":456}, …],
  "home":   {"id":123456,"nodeId":"ott770315","angle":1234567890} }
```
`dataVersion` is the source versions plus the first 6 hex digits of a hash over the tile bytes.

**`GET /api/v/{ver}/tiles/{level}/{sector}`** returns the tile blob with `application/octet-stream`, `Content-Encoding: gzip`, `Cache-Control: public, max-age=31536000, immutable`. An absent tile is `204`. A wrong `ver` is `404`, and the client then reloads meta.

**`GET /api/search?q=homo%20sap&limit=8`**
```json
[{"id":123456,"nodeId":"ott770315","name":"Homo sapiens","rank":"species","group":0,
  "flags":13,"leafCount":1,"childCount":0,"level":13,"angle":…,"arcLo":…,"arcHi":…,"r":1.0,
  "commonName":"Human","matched":"Homo sapiens","matchedKind":"scientific","matchedLang":null,
  "lineage":["Simiiformes","Catarrhini","Homininae"]}]
```
- `lineage` is the search context line (§5.2).
- An empty or too-short query answers `[]`, never `null`. A malformed `limit` is a JSON 400; `limit` is clamped to 1..50.

**`GET /api/nodes/{ref}`**
- `ref` is a pre-order `id` (digits, as sent by tile clicks), `ott770315` or `mrcaott…`, parsed by `db.ParseNodeRef` into `NodeRef{Kind, Num, Mrca}`.
- Numbers in refs, tile levels and sectors, and `limit` accept one leading `+` (`/api/nodes/+5`); `strconv.ParseUint` alone rejects it, so a small helper strips it first. Anything else that is not digits is a 400.
```json
{"id":123456,"nodeId":"ott770315","name":"Homo sapiens","rank":"species","group":0,
 "flags":13,"leafCount":1,"childCount":0,"level":13,"angle":…,"arcLo":…,"arcHi":…,"r":1.0,
 "commonName":"Human","ids":{"ott":770315,"gbif":2436436,"ncbi":9606},
 "lineage":[{"id":0,"nodeId":"ott93302","name":"cellular organisms","rank":"no rank","group":255,"angle":…,"r":0.08}, …],
 "children":{"total":0,"top":[{"id":…,"nodeId":…,"name":…,"rank":…,"leafCount":…}]},
 "namedAncestor":null}
```
- `lineage` runs root→parent and includes geometry, so the client can draw the selection path.
- `children.top` holds the 50 largest children. If `total > 2` the UI says "relationships unresolved".
- For an unnamed node, `namedAncestor` is the nearest named ancestor ("Unnamed clade within *Felidae*").

**`GET /api/nodes/{ref}/about[?retry=1]`** returns the enrichment document (§6.3) with `Cache-Control: public, max-age=86400` (partial documents `no-store`). It may take a few seconds on a miss; the card shows the core data first. `?retry=1` refetches a cached *partial* document only.

**`/*`** serves `web/dist` with `http.ServeContent` (never `http.FileServer`: no directory listings, no `/index.html` redirect) and an `index.html` fallback for deep links, only for paths without a file extension, so a missing `/favicon.ico` is a real 404.
- `/assets/` (hashed names) gets `immutable` cache headers; `index.html` gets `no-cache`; other root files (`favicon.svg`, `fallback.webp`) `public, max-age=86400`.
- Content types are fixed in `static.go` for `.js .css .woff .woff2 .webp .svg .json`, because Go's own table depends on the system's `/etc/mime.types`.
- `GET /api` and `GET /api/…` that match no route are a JSON 404, never `index.html`.

### 5.2 Search
1. **Normalise** the query: trim and lowercase it. Shorter than 2 chars returns `[]`.
2. **Tokenise** on whitespace, drop `"` characters, and build `"tok1"* AND "tok2"*`. **Two-character queries** match whole words only (`"ox"`, not `"ox"*`): a 2-letter prefix hits ~27k names that bm25 must score, while whole words stay under 2 ms and still find "Aa".
3. **Fetch candidates in two passes:** for prefix queries a whole-word FTS pass runs first and the prefix pass is added after (64 + 64 candidates, `ORDER BY rank`), since "cat"* matches 10k names and bm25's top 64 missed the plain "Cat".
4. **Re-rank in Go** (`internal/db/search.go`). The query and each matched name are folded the same way (`internal/names.Fold`, which follows the FTS tokenizer), so "onca"/"onça" equal GBIF's "Onca". The score is a sum:
   - exact full-name match +100; name starts with the query +20; scientific name (`kind=0`) +5
   - `+ 2·log10(leaf_count+1)`, so clades like "Felidae" beat obscure tips
   - `+ 3·log10(vernacular_rows+1)` (fame), so well-known taxa beat obscure ones with the same name quality
   - `+ 1` if the tip is species rank

   Each product is wrapped in an explicit `float64(…)` conversion so the compiler cannot fuse a multiply and an add into one FMA (arm64 does), which would round differently and could swap two equal scores. Several names of one node keep the best-scoring one; the final order is score, then leaf count, then id.
5. **Context line.** A hit's `lineage` is the 3 nearest *named* ancestors above genus (any rank, named "no rank" included; genus-and-below ranks, the root and OTT placeholders such as `h2007-1`, "… incertae sedis", "unclassified …" skipped), broadest first: Homo sapiens → Simiiformes › Catarrhini › Homininae.
6. **Goal:** "homo sap" returns Homo sapiens first, "felidae" returns Felidae first, and "human", "lion", "jaguar" and "onça" find the right species.

### 5.3 DB access in the server
`server.State` holds the `tree.db` pool (`*sql.DB`), the meta JSON and data version read at start, and, once `WithEnrichment` is called, the `cache.db` pool and the enricher. A `State` without them answers `/about` for named nodes with a 503, which keeps tests that only read the tree off the network.
- `database/sql` is already a pool that is safe for concurrent use, so handlers call queries directly, with no lock. Every query takes the request's `context.Context`, so a client that goes away cancels its query. Queries take tens to hundreds of microseconds.
- `Run` listens on `0.0.0.0:PORT` and stops on Ctrl+C or SIGTERM (`signal.NotifyContext`), then `srv.Shutdown` waits for in-flight requests.

---

## 6. Enrichment (`internal/enrich/`): lazy, cached, attributed

### 6.1 Flow for `GET /api/nodes/{ref}/about`
1. Look up the node in `tree.db`: `node_id`, name, rank, `gbif_id`, the lineage, and the ott id if any. mrca nodes get a minimal, uncached document and the card shows no about section for them.
2. **Check the cache.** A row is fresh for 30 days when complete, 1 day when partial, and 10 minutes when partial and rate limited (`TTLRateLimited`). Stale rows are served and refreshed in the background, except while the Wikimedia gate is shut (§6.2).
3. **Stage A, in parallel** (one goroutine per call under a `sync.WaitGroup`), 4 s per call:
   - **Wikidata item.** `action=query&list=search&srsearch=haswbstatement:P9157={ott}&srlimit=5` returns QIDs (Homo sapiens gives 2), then `action=wbgetentities&ids=…&props=claims|sitelinks&sitefilter=enwiki|ptwiki`. Choose the item whose P225 (taxon name) equals the OTT name, else the first. Extract P18 (image), P141 (IUCN status), P846 (GBIF key) and the enwiki/ptwiki titles. Without an ott id or a hit, search `haswbstatement:P846={gbif}`. The Action API is used instead of WDQS: faster, more reliable, and the same for both lookups.
   - **GBIF species.** `GET /v1/species/{gbif}` gives `authorship`, `publishedIn`, `vernacularName`, `rank` and `family`. The key comes from OTT `sourceinfo`, else Wikidata P846, else it is skipped.
   - **GBIF occurrences.** `GET /v1/occurrence/search?taxonKey={gbif}&limit=0&facet=country&facetLimit=300&hasGeospatialIssue=false&occurrenceStatus=PRESENT` gives the total and per-country counts; countries below `max(3, 0.1% of total)` are dropped. This faceted search gets 10 s (`SlowTimeout`): cold queries took 5–20 s in testing.
4. **Stage B, in parallel** (depends on stage A):
   - **Wikipedia.** `GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}` gives `extract`, `description`, `thumbnail.source` and `content_urls.desktop.page`. Titles go into the URL as one path segment, escaped by the WHATWG path-segment rules plus `/` and `%` (`escapePathSegment`; Go's `url.PathEscape` would encode `()!*'`). **Ancestor fallback:** without an article, try up to 3 nearest named ancestors of rank genus, family or order (each a Wikidata lookup by ott id plus the summary, cached results reused), labelled "About the genus *Panthera*".
   - **Image licence (Commons).** For P18, `action=query&titles=File:{f}&prop=imageinfo&iiprop=extmetadata|url&iiurlwidth=640&iiextmetadatafilter=LicenseShortName|Artist|LicenseUrl`. `Artist` is HTML, stripped to text.
   - **iNaturalist photo**, only without P18: `GET /v1/taxa?q={name}&per_page=5`, the result whose `name` matches exactly, its `default_photo` only if `license_code ∈ {cc0, cc-by, cc-by-sa, cc-by-nc}` (never a null licence).
   - **IUCN fallback**, only without P141 and for species: `GET /v2/species/match?scientificName={name}`, reading `additionalStatus[datasetAlias=IUCN].statusCode`.
5. **Assemble and store**, with `complete = every call succeeded or returned a definite "none"`. Partial results are fine. The **generated sentence** uses GBIF's `rank` and `family` where the synth lineage lacks them.

### 6.2 Etiquette and limits
- **User-Agent:** `species-circle/<version> (+{SPECIES_PUBLIC_URL}; {SPECIES_CONTACT})`, both from env vars and never hard-coded. Without them the UA says "Circle of Life tree viewer, local development" and the server logs one warning at start; a public deployment must set them (Wikimedia returns 403 to generic UAs).
- **One buffered channel per host family, used as a semaphore:** GBIF 8; Wikimedia (Wikidata, Wikipedia, Commons) 4; iNat 1, plus a minimum 1 s gap (`INatGap`), kept by holding a `sync.Mutex` across the wait.
- **No sleeping in the request path:** `429`/`503` fail fast (`complete=0`).
- **The Wikimedia gate** (`gate.go`), passed by every Wikimedia request before its semaphore slot: a token bucket of 4 requests/s with bursts of 8 (`WikimediaRate`, `WikimediaBurst`), where a request that would wait over 3 s (`MaxThrottleWait`) is not sent and fails as rate limited; and after a `429` or `503` from any of them the gate shuts for the `Retry-After` (seconds or an HTTP date; 60 s without one, `DefaultCooldown`; at most 10 min, `MaxCooldown`). Until then every Wikimedia request fails at once; GBIF and iNat go on. Every such failure wraps `enrich.ErrRateLimited` and sets the document's `rateLimited`.
- **One fetch per node at a time** (`internal/server/flight.go`): concurrent requests for the same uncached node, and a background refresh, share one fetch. It runs detached from the request (`context.WithoutCancel` plus a 30 s `FetchTimeout`), so a reader who clicks on mid-fetch still leaves a stored document behind; only a fetch cut off by `FetchTimeout` is not stored.
- **The client waits for a selection to settle** 500 ms before asking for `/about` (`web/src/wait.ts`, `ABOUT_SETTLE_MS` in `ui/panel.ts`), so arrow-key walks and quick clicks cost nothing upstream. A Retry click asks at once, then holds every Retry button for 5 s.
- **No bulk pre-fetch.**
- **Tests run without the network.** Each upstream base URL lives in an `Endpoints` struct in `internal/config`. Tests point it at `internal/enrich/enrichtest`, an `httptest` mock that answers every service from the JSON fixtures in `tests/fixtures/enrich/` (`config.EndpointsUnder(base)` puts each service under its own path prefix), or test the parse functions on the fixtures directly. The fixtures were captured live (Wikidata entity files trimmed to the properties we read).

### 6.3 `/about` document
```json
{"nodeId":"ott770315",
 "taxonomy":{"authorship":"Linnaeus, 1758","publishedIn":"Syst. Nat. ed. 10","source":"GBIF"},
 "commonNames":[…],
 "summary":{"text":"…","description":"…","title":"Human","url":"https://en.wikipedia.org/wiki/Human","license":"CC BY-SA 4.0","about":null},
 "image":{"url":"…","width":640,"height":…,"credit":"Jane Doe","license":"CC BY-SA 4.0","licenseUrl":"…","source":"Wikimedia Commons","pageUrl":"…","about":null},
 "status":{"code":"LC","source":"Wikidata"},
 "distribution":{"occurrences":1234,"countries":[["BR",120],["US",80]],"countryTotal":54,"gbifKey":2436436,"bbox":…},
 "generated":"Homo sapiens Linnaeus, 1758 is a species in the family Hominidae, with 1,234 GBIF occurrence records from 54 countries.",
 "links":{"opentree":"https://tree.opentreeoflife.org/opentree/argus/opentree16.1@ott770315","wikipedia":"…","wikipediaPt":"…","wikidata":"…","gbif":"…","inat":"…","iucn":"…"},
 "failed":[],"complete":true,"fetchedAt":1761600000,"rateLimited":false}
```
- **`about`:** set when the text or image comes from an ancestor, e.g. `{"nodeId":"ott…","name":"Panthera","rank":"genus"}`.
- **`generated`:** always present, shown only when there is no summary.
- **`failed`** lists sources that failed; the card shows "Couldn’t reach X. Retry".
- **IUCN mapping:** P141 QIDs map to codes through a small `switch`, verified against the live Wikidata labels (fixture `wd_iucn_statuses.json`, `TestIUCNMapMatchesTheLiveLabels`): LC Q211005, NT Q719675, VU Q278113, EN Q11394, CR Q219127, EW Q239509, EX Q237350, DD Q3245245. Homo sapiens has no P141 and GBIF reports NE, so it shows no status.
- **Map:** the client builds GBIF tile URLs directly, with no proxy: density tiles (`purpleYellow.poly`, hex bins, CSS grayscale) over GBIF's `gbif-dark` OpenMapTiles base map, 512 px tiles, no map library. Hidden when `occurrences == 0`. Credit: GBIF.org, OpenMapTiles, OpenStreetMap.
- **Field order is JSON key order** of the Go structs, and absent values are pointers that encode as `null` (no `omitempty`: the client reads one shape with every key present). Slices are never nil, so empty lists are `[]`. A country count is a two-element array through its own `MarshalJSON`/`UnmarshalJSON`.

---

## 7. Frontend (`web/`)

### 7.1 Modules
```
web/src/
  main.ts            bootstrap: fonts → meta → renderer → input → url → ui; URL flags (§7.11)
  api.ts, types.ts   typed fetch wrappers (+ AbortSignal) and payload types
  angle.ts           u32 helpers: toRad, wrapDiff, sectorOf(level), widen
  camera.ts          double-precision view transform, screen↔world↔polar, uniforms (hi/lo split)
  rig.ts             the locked view (zoom and rotation) and free view, written into the camera (§7.5)
  layout.ts          per-viewport composition: card rectangle, anchor, focus angle, wheel radius
  orient.ts          auto-orient switch (R, the menu)
  freeview.ts        free view mode switch (F, Esc, the padlock)
  input.ts           pointer/wheel/pinch/keys → rig; drag turns the wheel; flings; double-click zoom
  spin.ts            the wheel's own motion: ambient turn and fling inertia
  tour.ts            the idle tour: curated species, dwell, stop on input, resume when idle
  flyto.ts           van Wijk–Nuij flights along the rim, turn-only paths, flights back from free view
  ease.ts, wait.ts   easing curves; an abortable pause
  lod.ts             λ, V, visible angular range, wanted tile keys
  tiles/decode.ts    zero-copy decoder (typed-array views at offsets)
  tiles/cache.ts     fetch queue, AbortController, LRU, GPU resource lifecycle (§7.6)
  tiles/fans.ts      frontier fans
  scene.ts           the frame loop (render on demand) over the renderer
  render/types.ts    the Renderer interface and the frame types (§7.13)
  render/plan.ts     pure frame plan: every per-draw decision, executed by gl/renderer.ts
  render/canvas.ts   backing-store size and DPR cap
  render/pixels.ts   top-down RGBA readback and the precision comparison
  gl/                the WebGL2 renderer: context helpers, renderer; shaders/*.vert|frag|glsl
  palette.ts         OKLCH → linear sRGB; run colours from meta.runs (§7.4)
  style.ts           every tuning constant (sizes, fades, alphas)
  labels.ts          Canvas2D overlay: tip labels, clade labels and bars, group labels, "You are here"
  labelLayout.ts     the pure half of labels: culling, hysteresis, placement
  names.ts           names set in runs (italic Latin, roman markers), genus abbreviation
  callout.ts, leader.ts  the selection's leader polyline; the home leader bar's length
  picking.ts         CPU hit testing over loaded tiles (doubles)
  hover.ts, path.ts  hover path and tooltip; lineage → arc + radial segments
  nodes.ts           shared cache of /api/nodes answers
  nav.ts             keyboard tree navigation
  selection.ts       the selection: flights, card, leader, URL, announcements
  inview.ts          "species in view", analytically
  crossfade.ts       the reduced-motion cut's 120 ms crossfade
  url.ts             deep-link parse/serialise
  debug.ts           ?debug HUD and the precision test (lazy chunk)
  fallback.ts        the no-WebGL2 page
  ui/hud.ts          wordmark, bottom readout + breadcrumb, kingdom key
  ui/zoomstrip.ts    the zoom strip on the left edge
  ui/freebutton.ts   the free view padlock
  ui/search.ts       ⌘K / "/" palette, WAI-ARIA combobox
  ui/panel.ts        the selection card; ui/tabs.ts its tabs; ui/fit.ts fits a tab's content
  ui/about.ts        the card's about tabs (§6); ui/occmap.ts the GBIF density map
  ui/credits.ts      Data & credits dialog and the wordmark menu; ui/keys.ts the Keyboard dialog
  ui/obstacles.ts    every screen area the canvas respects
  styles.css         tokens from DESIGN.md
  *.test.ts          vitest
```
**Render on demand:** a frame is requested only when the camera, tiles, hover, animation or fades change. That saves battery and makes `window.__renderIdle` meaningful.

### 7.2 Precision: camera-relative polar rendering
At max zoom (48 px between tips) the rim circumference is about 115M px. Float32 world coordinates would jitter by several pixels, so:

- **Camera state** lives in JS doubles: `camAngle`, `camR` (world radius of the screen centre), `scale` (px per world unit) and `rotation`.
- **Per frame** it becomes uniforms: `uCamA` as a `uint` (the angle as u32), `uCamR` as a hi/lo float pair (`hi = Math.fround(camR); lo = camR − hi`), `uScale`, `uRot`.
- **In the shader, for a node at `(a: uint, r: float)`:**
  ```glsl
  float dth = float(int(a - uCamA)) * TAU_OVER_2_32;   // exact uint wrap, small int → float
  float s   = sin(0.5 * dth);
  float x   = ((r - uCamR.x) - uCamR.y) - r * 2.0 * s * s;  // = r·cosΔθ − camR without cancellation
  float y   = r * sin(dth);
  // rotate (x,y) by -uRot, scale by uScale → clip space
  ```
  `r·cosΔθ − R` rewritten as `(r−R) − 2r·sin²(Δθ/2)` avoids catastrophic cancellation. Both sines go through `sinPrecise` (`common.glsl`): GPU `sin` is often only accurate to about 1e-6 absolute, which is useless for tiny angles (1e-6 rad is about 18 px at max zoom), so below 0.1 rad it uses a Taylor series.
- Node radii are f32, quantised to at most 1 px at max zoom; they are static, so that does not jitter. Tips are exactly 1.0.
- **`?debug=precision`** sets the camera directly, moves it by exact pixels at max zoom and measures tip-bar centroids (`window.__precision`), without the HUD's dim plates (`scene.dimsOn`): max 0.215 px on the GPU, 0.33 px on SwiftShader.

### 7.3 Draw passes, in order per frame
The renderer executes these passes from the frame plan (`render/plan.ts`, §7.13): `fans`, `branches`, `arcs`, `rim`, `edge`, `marks`, `tips`, `backdrop`, `dim`, `path`, `ring`. The canvas is black with `alpha: true`. Blending (`PASS_BLEND`): **saturating** `(1 − dst alpha, 1)`, alpha counting light, for the tree, the rim ring and the backdrop, so dense areas converge on their hue instead of clipping to white; **additive** for rim marks; **over** for the rim edge, tip dots, paths and rings; **dim** for the tree dim and HUD plates. Constants are in `style.ts` (see DESIGN.md §5).

**Frontier fans** (`tiles/fans.ts`) are drawn first: hashed strands that build up towards the rim; fans under 1.5 px wide are skipped (thousands of 1 px slivers cost more than everything else), and fans fade out over λ 12.5–13.5.

1. **Branches**, one instance per node, from `parent_r` to `r` (or to 1.0 for frontier nodes). Colour `mix(branchGrey, runColour(θ), smoothstep(0.55, 1.0, r))`, the grey-interior, coloured-near-rim look of 4.png; alpha about 0.35 × the fade. Hairlines are 1 device px; once the line width (`LINE_DEEP_PX` × smoothstep over `LINE_WIDTH_SPACING`, 8 → 32 px between tips) passes a device px, branches and arcs become antialiased quads (12 vertices per branch, `6K` per arc).
2. **Arcs**, `instanceCount = internal_count`, clamped to the visible angular window and subdivided: `K = 128` for tile levels ≤ 3, `K = 16` otherwise (chord sag under 0.2 px at overview).
3. **Rim ring**: an analytic glow around r = 1, `colour(θ) · (core·exp(−(δ/σ1)²) + halo·exp(−δ/σ2))`, δ the pixel distance to the rim, drawn as an annulus (140 px inside, 48 px outside) with hashed outward "fur"; the inner halo's tail is subtracted at the annulus edge, so there is no straight-edged step. It fades out as tips become resolvable (λ > 12). The **rim edge** is a crisp line at the rim drawn over the glow.
4. **Rim marks** (instanced quads with soft `exp` edges: a crisp core and a halo without any blur pass):
   - **Clade spike:** outward from r = 1, `clamp(3 + 2·log2(leaf_count), 3, 14)` px long, as wide as the node's angular span (≥ 1 px), alpha falling off outward.
   - **Tip bar** (λ ≥ 12): the last `min(terminal length, 120 px)` of the tip's own hairline brightened in its colour, as wide as the hairline. It fades in with λ 12 → 13.5 and out again as tips spread from 2 to 6 px apart, so at deep zoom each branch runs into its species name as one even line.
   - **Home** (Homo sapiens) is white, with a short outward leader bar past its label (`leader.ts`: starts `HOME_LEADER_PAD_PX` past the measured label, capped at the 16 px gutter, faded out when squeezed below about 60 px), not drawn while it is the selection. Its two subspecies draw as one white bar.
   - **Tip dots** mark tip ends at deep zoom, opaque on their line.
5. **Path overlay**: opaque quads through the precise polar transform (at least `PATH_LINE_RATIO` × the line width): the hover path (text-1 at 60% brightness, since a translucent grey vanishes over bright bars) and the selection path (white); a thin **ring** marks the selected node.

Between the rim marks and the path overlay come the **backdrop** (a wheel-linked graticule and wash behind the glass card that fills only the light the tree left, DESIGN.md §5.1) and the **dim** (the tree darkened behind every obstacle in `ui/obstacles.ts` with a soft-edged plate whose falloff runs from the text box over pad + soft, 28 px, plus the full-screen hover dim).

**Fades:** alpha × `smoothstep(level, level+0.6, λ)`. Frontier extensions and spikes fade out as `child_level` fades in.

**Intro:** `uReveal` clips everything with `r > uReveal`, animating 0 → 1.05 over 900 ms with `cubic-bezier(0.2,0,0,1)`; then labels and HUD fade in over 200 ms. After the intro it is a finite sentinel (`REVEAL_DONE = 1e4`), not Infinity: `smoothstep(∞ − s, ∞, r)` is NaN, and shader compilers may assume floats are finite. Skipped under reduced motion and with `?shot`.

**Frame times** (WebGL2, AMD iGPU, `SHOT_GPU=1`): overview 3.5 ms, mammals 6.3 ms, deep-homo 1.3 ms, panel-homo 1.4 ms, 2560×1440@2 overview 7.8 ms, mobile 2.6 ms.

### 7.4 Colour
- `palette.ts` holds the OKLCH ramps from DESIGN.md as numbers and converts them to sRGB.
- Colour is computed analytically from `meta.runs`, in the shaders (`palette.glsl`, runs and colours as uniform arrays) and on the CPU (`RunPalette.colourAt`, for label colours) with the same formula.
- A run spans from half a tip slot before its first tip to half a slot after its last, and maps `t ∈ [0,1]` to its group's ramp, so every angle gets exactly its own group's colour, even Archaea at 0.087% of the circle.
- Neighbouring runs meet in a seam of `SEAM_PX` screen px, at most a quarter of the shorter run, mixed linearly in sRGB (no detour round the hue circle).
- The rim ring computes it per fragment; lines, fans and marks per vertex.

### 7.5 Camera, input and auto-orient
The view is locked (`rig.ts`, layout in DESIGN.md §4): its state is a **zoom** and a **rotation**, and there is no pan. The one exception is the opt-in **free view** (`freeview.ts`; `F` or the padlock beside the zoom strip, DESIGN.md §4.1 "Free view"): drag pans, zoom follows the cursor, and the padlock, `F` or `Esc` fly back to the locked view.

- **Composition** (`layout.ts`, per viewport, CSS px; numbers in DESIGN.md §4.1 and §4.3): the card's rectangle, the **anchor** (a screen point on the rim, just below and left of the card), the **focus angle** φ0 (the screen angle from the wheel's centre to the anchor: 30° on desktop, 60° on a phone) and the wheel's radius R0 at minimum zoom, R0 = (anchor.y − 64) / (1 − sin φ0) on desktop, so the rim's top sits under the header.
- **State:** `scale` (device px per world unit, from R0 to 48 CSS px between tips) and `theta`, the world angle of the rim point on the anchor. The camera is derived: `rot = φ − theta`; the wheel's centre is at `anchor − scale·(cos φ, −sin φ)`; the world point under the screen centre is the anchor's rim point plus the anchor→centre offset turned back by `rot`, so it stays exact at any zoom.
- **Zoom** changes `scale` only, which scales the picture about the anchor. Wheel (`exp(−dy·0.0015)`, normalised for `deltaMode`), pinch, `+`/`−`, the zoom strip and double-click (×2) all zoom about the anchor.
- **Rotation** changes `theta` only. A drag turns the wheel by the angle the pointer sweeps about the centre (at deep zoom this slides the rim along), with inertia; two fingers twisting turn it by the change in their angle.
- **Deep-zoom composition:** with `k = smoothstep(log2 0.25, log2 4, log2 tipSpacingCss)` and `u = (log2 scale − log2 minScale) / (log2 endScale − log2 minScale)`, where `endScale` puts tips 4 CSS px apart,
  - `φ = φ0 · (1 − turn·k)` (auto-orient): at deep zoom the rim runs vertically through the anchor and tip labels read left to right (1.png);
  - `anchor.x = x0 + (deepX − x0) · smoothstep(0, 1, u)`: the anchor drifts left over the whole zoom, slowly and evenly, to `deepX` = min(x0, 33% of the width, card left − 360 px) on desktop (min(x0, 30%) on a phone), so the column of names clears the card.

  The turn only makes sense once the rim is straight on screen, while the slide is spread out so it is never felt as a jump. Because `theta` is fixed while zooming, the view turns about the anchor and the selection never moves; there is no tween to coordinate with flights. `R` (or the menu) eases `turn` between 1 and 0 over 400 ms; reduced motion cuts.
- **Reset** flies to minimum zoom with the selection on the anchor.
- **The wheel's own motion** (`spin.ts`): one angular velocity `v` eases to a target with friction, `v ← T + (v − T)·e^(−dt/τ)`, τ = 400 ms, and the wheel turns by its exact integral each frame (dt capped at 250 ms). The target is the ambient rate (20 CSS px/s at the anchor at every zoom), eased in after the last input, and 0 while blocked (a flight, a drag, the pointer over the card, search open, an input focused, a hidden tab, the intro). A released drag or twist sets `v` to its release velocity (a fling), which decays into the target.
- **Idle tour** (`tour.ts`; timings in DESIGN.md §6): after `FIRST_MS` on a plain visit, then `DWELL_MS` on each selection, the next species from a curated list of 22 (OTT ids checked against otl16.1; *E. coli* has no species node) is selected with a fly-to path at the same zoom. Shuffled, no repeats until all are seen. Steps replace the URL (no history) and are not announced. Any input stops it; it resumes after `RESUME_DWELLS` dwells without input, and recent pointer or touch input, the card, search, dialogs, flights, a loading selection or a hidden tab hold the countdown. It runs on timers, not frames, so a still scene stays idle between steps. The list also feeds the search palette's "Try" rows. A deep link starts it stopped.
- **Off** under reduced motion; `?still` (implied by `?shot`) turns off the ambient turn, fling and tour; `?tour=<s>` sets the dwell and turns the tour on alone.

### 7.6 Tile manager (`tiles/cache.ts`)
- **Wanted set:** `lod.ts` computes the wanted keys per frame.
- **Fetching:** missing keys are fetched with at most 6 in flight, lowest level first, then nearest to the centre; up to 3 retries. Requests for keys no longer wanted are aborted. A 404 for a stale `dataVersion` reloads meta.
- **On arrival:** the tile is decoded, its GPU resource created by the renderer, and a lookup `Map<id, {tile, idx}>` updated for picking and hover. The manager is generic over the GPU resource, so tests run without a GPU.
- **Eviction:** LRU at 400 tiles. Levels ≤ 3 are never evicted. Evicting releases the GPU objects.
- **Progressive rendering:** whatever is loaded is drawn. Missing deep tiles just mean less detail, while frontier extensions keep the picture complete.

### 7.7 Labels (Canvas2D overlay, ≤ 300 per frame)
- **Tip labels**, shown when tip spacing ≥ 11 px: Source Serif 4 italic for genus/species/infraspecific ranks, roman for "no rank" tips; just outside the rim along the radial direction (horizontal once auto-oriented); colour the run colour shifted toward text-1; the home tip white; no glow on text. A label that would cross the screen side gets an abbreviated genus ("D. ruscinensis", `abbreviateGenus`) before it is dropped.
- **Names are set in runs** (`names.ts`): italic Latin; roman for rank markers (`subsp. var. f. sp. …`), strains and informal parts. Used by labels, the breadcrumb, the card and search. Genus italics on tiles (which carry no rank): a name is italic when it is the first word of a binomial seen in a tip name.
- **Clade labels.** A named clade's arc usually sits only a few px outside its parent's (dozens of nested mrca levels), and near the rim no arcs are on screen. So a clade is labelled on its own arc (glyph by glyph, Hanken Grotesk 11–13 px, text-2) only where the stem can hold the text plus 24 px; otherwise it gets a **clade bar outside the rim**: a hairline arc over its tips (extent from `first_tip`, §3.7) with end ticks and the name beyond it, as in printed phylogenies. Bars go to clades with ≥ 90% of their extent on screen that take ≤ 60% of the visible rim; nested bars stack outward in at most `CLADE_MAX_LANES` = 3 lanes (the innermost stay); at deep zoom they sit beyond the tip-label column, bracket genera, and their names are horizontal. Bars are clipped to the gutter and the HUD band.
- **Group labels** (Animals, Plants, Fungi, Protists, Bacteria, Archaea): outside the rim at each group's largest-run midpoint, text-2 at 13 px with the kingdom swatch rule. Group labels and clade bars switch on how much of the rim is on screen (whole-wheel mode, with hysteresis), not on λ, and each family fades over 150 ms.
- **Culling** is greedy by priority (leaf count; tips 1e9; home, the selected tip and group labels on top). Already-shown labels count double; hysteresis is fit ≥ 1 to show, < 0.85 to hide; each label fades over 150 ms, keyed by node id. Placement alternatives slide a clade name along its bar to clear a hairline (the selection leader, "You are here"), a soft obstacle. Hairlines are drawn under the names and cut round the glyphs they cross (`HAIRLINE_KNOCK_PX`). The HUD's text rectangles and the home leader bar are hard obstacles; the home leader's obstacle hides the two subspecies labels, so the white label stands alone as in 1.png.
- **"You are here"**: at low zoom, a hairline leader from the Homo sapiens tip to a small label outside the rim, fading out once the tip itself is labelled.
- **Fonts:** `document.fonts.load()` for all three faces before the first label draw; text width is measured once per (font, string) and cached.

### 7.8 Picking and hover (CPU, doubles)
- **Picking** (`picking.ts`) hits what is drawn (tiles ≤ V), with the pointer converted to `(θ, r)` in doubles. In the rim zone (inside to the tip bars, outside past the spikes or, once tips are labelled, over the label column): the nearest tip by binary search in each tile's tip run, else the deepest frontier clade whose tips contain θ. Elsewhere: the nearest radial segment (run on to the rim while the children are not drawn) or arc within 4 px (12 px for touch), ties to the deeper node. Homo sapiens' two subspecies, drawn as one bar, pick Homo sapiens.
- **Hover** (`hover.ts`, throttled to animation frames) draws the partial root→node path from the tiles' parent links at once and completes it to the root from `/api/nodes` after 90 ms (answers shared through `nodes.ts`). The path follows what is drawn, so a frontier node's path runs on to the rim. Everything else dims to 60%, the label overlay too. A tooltip shows the name in its correct style, then the rank and "N species", muted.
- **mrca nodes** are titled "Unnamed clade", "within X", plus "Common ancestor of A and B" from the two OTT ids in the node id (their names fetched), falling back to its two largest named children.

### 7.9 Fly-to (`flyto.ts`)
- **Algorithm:** van Wijk & Nuij smooth zoom (ρ = 1.4) in one dimension: the "pan" is the arc along the rim from the current anchor angle to the target's (the short way round), the view width the screen's shorter side over the scale; `r_i = −asinh(b_i)` for precision on deep zooms; s eased by smoothstep. Zoom stays within the rig's range, so a long way round at minimum zoom simply turns. For a far target the path zooms out, glides round, then dives in.
- **Duration:** `clamp(S·600 ms, 600, 2000)`. Any user input cancels it.
- **Target:** the node's angle on the anchor at the zoom that suits it: its tips (`leafCount` slots, at least 24) fill 60% of the screen's height along the rim, clamped to the zoom range. A species lands at about 22 px between tips, so its neighbours' names show; a small clade whose tips would be 3 px apart or more zooms on to 14 px.
- **Used by:** search results, lineage and children links in the card, breadcrumb segments, the kingdom key, keyboard tree navigation and Back/Forward. A deep link with only `n` cuts to the same pose.
- **Turn** (a click or tap on the canvas): the zoom stays and only the angle eases, 250–900 ms by how far the anchor's content travels on screen.
- **From free view** every flight is a way back to the locked view: the same path in two dimensions, from the free camera to the camera the locked target puts on screen (`Rig.cameraFor`), with the screen rotation eased the short way round.
- **Reduced motion:** a cut plus a 120 ms crossfade of a snapshot of both canvases (`crossfade.ts`; the old view is re-rendered first, since a WebGL buffer is only readable in the task that drew it).
- Measured (WebGL2, AMD iGPU, 1440×900): "homo sapiens" + Enter from the overview lands in 2.0 s; warm frame time p50 4.8 / p90 8.1 ms with no dropped frame.

### 7.10 HUD, search, card
Placement, sizes, copy and states are in DESIGN.md §4; this is how they are built.
- **HUD** (`ui/hud.ts`): flat DOM, no plates; every box registers in `ui/obstacles.ts`, so labels keep clear and the renderer darkens the tree behind it (the dim pass, §7.3). The breadcrumb is always the selection's lineage, so the canvas, the card and the HUD never disagree. "Species in view" is exact and cheap because tips are evenly spaced: count = visible rim angle / slot (`inview.ts`). The chrome fades to 40% while dragging.
- **Zoom strip** (`ui/zoomstrip.ts`): a `role="slider"`, `t = (log2 scale − log2 min) / (log2 max − log2 min)`, reading `% = 2 + 98·t` (2% at minimum zoom, 100% at 48 px between tips). Drag sets the zoom about the anchor, a click flies there. It reads the rig every frame, so wheel, pinch, flights and the tour move it too, and it counts as input (stops the tour and the ambient turn).
- **Search palette** (`ui/search.ts`): a WAI-ARIA combobox (input `role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; a listbox with `aria-selected`), focus kept in the input. 120 ms debounce, the previous request aborted, answers cached per query, and the active result's node prefetched so choosing starts the flight at once; Enter pressed before the answer takes the first result once it arrives. The tree dims to 50% through an obstacle plate, the label overlay through its opacity. Junk names sort last (`junkLast`); Homo sapiens and its subspecies get the white swatch (`isHomeHit`).
- **Card** (`ui/panel.ts`): always present, since there is always a selection. A fixed box (`cardHeight`); the composition uses its nominal box, the leader its real one (`Panel.box`). Nothing scrolls: tabs (`ui/tabs.ts`, the ARIA tabs pattern) whose content is fitted to the tab area (`ui/fit.ts`). The head and Tree tab come from `/api/nodes` at once; Overview and Range from `/about` (`ui/about.ts`, `ui/occmap.ts`) after the settle wait (§6.2). A selection arriving by a flight longer than 600 ms switches the card, leader and breadcrumb at 60% of it (`selection.ts` `pending`). Loading is a truthful hairline progress bar, never a spinner.
- **Leader** (`callout.ts`, on the label canvas): `leaderStart` picks the start on the selection's stem (the screen segment from its ring to the rim) inside the free area, sliding to the rim as a clade's node leaves the screen, or where the ray from the anchor leaves the free area, with an arrowhead; `afterName` moves it past the selection's name (or the name column) once names show; `columnLead` runs a tip's leader along its own row past the name column before it rises. Every step is continuous in the view. Its boxes are soft obstacles for clade text and hard ones for tip names.
- **Wordmark menu** (`ui/credits.ts` `mountWordmarkMenu`): Data & credits, Keyboard (`ui/keys.ts`), Auto-orient and Tour toggles, and the kingdom key below 720 px.

### 7.11 URL, keyboard, accessibility
- **URL** (`url.ts`):
  - `?n=ott770315` selects the node (default Homo sapiens), pushed with `pushState` on select, so Back and Forward fly between selections. Without `v` the view cuts to the node at the zoom that suits it.
  - `&v=a,z` restores the locked view: `a` the angle at the anchor (u32 units), `z` log2 of the zoom in CSS px per world unit. Replaced with `replaceState` 300 ms after the view settles.
  - `&v=a,r,z,rot` is a free view: the polar angle and radius of the world point at the screen centre, the zoom, and the screen rotation in degrees. Links from before the locked view have this form, so they open in free view.
  - A plain visit always opens on Homo sapiens at minimum zoom; nothing is restored from storage.
- **Flags:** `?shot` skips the intro and hides the cursor; `?reduced` forces reduced motion; `?still` stops the wheel's own motion; `?tour=<s>` sets the tour's dwell; `?debug` shows a HUD (frame time, tiles, instances, λ, V); `?debug=precision` runs the jitter test (§7.2). Renderer flags are in §7.13.
- **Keys:** `/` or `⌘K` opens search; `Esc` closes the topmost layer (search, dialog, menu) or leaves free view, and never clears the selection; `+`/`-` zoom about the anchor; `↑` or `Backspace` selects the nearest named ancestor, `↓` the largest child, `←`/`→` siblings in the card's largest-first order, wrapping (`nav.ts`; only the 50 listed siblings are reachable in a polytomy); `H` flies back to Homo sapiens; `R` toggles auto-orient; `F` toggles free view.
- **Accessibility:** the canvas has `role="img"` with a live `aria-label`; selection is announced through an `aria-live="polite"` region in words ("Felidae, family, 91 species."; tour steps are not); DOM order puts the card right after the header; search is a WAI-ARIA combobox; the card is an `<aside>` with real headings; focus rings are visible; contrast is AA.
- **No WebGL2** (`fallback.ts`, forced with `?nowebgl`): a 1080² still of the default overview (`web/public/fallback.webp`, 96 KB, generated by the shot script) with the DESIGN §7 sentence; search, the card and Data & credits work without the scene.

### 7.12 Performance budget

| Item | Budget |
|---|---|
| JS + CSS + HTML | ≤ 60 KB gz (measured: JS 70.8 KB gz, one file with the renderer and shaders; CSS 8.6 KB gz; `?debug` is a 1 KB lazy chunk) |
| Fonts (3 woff2 subsets, latin + latin-ext) | ≤ 120 KB |
| Tiles for first frame (levels 0–3, 15 tiles) | ≤ 250 KB gz |
| First frame (broadband, warm server) | ≤ 1.0 s |
| Frame time on an integrated GPU | ≤ 8 ms |
| Instances per frame | ≤ 150k |
| Draw calls per frame | ≤ 4 per tile + 3 |
| Tree canvas backing store | ≤ 6 Mpx (`MAX_BACKING_PX`) |

**Backing-store cap:** the tree canvas holds at most 6 Mpx (`render/canvas.ts` `treeDpr`, never below DPR 1); larger canvases render the tree at a lower effective DPR while the label overlay keeps the full DPR. At 5K (2560×1440 CSS, DPR 2) on the dev iGPU: uncapped 14.7 Mpx took 10.7–12.8 ms, 6 Mpx 7.0–7.9 ms.

### 7.13 Renderer: WebGL2 and the frame plan
- **Raw WebGL2, GLSL, no libraries** (`gl/renderer.ts`, `gl/shaders/`). `main.ts` creates it directly; when the canvas gives no `webgl2` context, or a shader fails to build, `createWebGl2Renderer` returns null and the fallback page is shown (§7.11). `?nowebgl` forces that page; `window.__renderer` is `webgl2` or `none`, and the harnesses assert it. The context is `alpha: true, premultipliedAlpha: true, antialias: true` (4× MSAA); the alpha channel is the saturating blend's light counter. WebGL context loss is not handled: a lost context leaves the canvas blank until a reload.
- **Drawing:** each tile is one buffer and one VAO with instanced attributes at its arrays' offsets (§3.7). Branches, arcs, rim marks and tip dots are instanced per node, the frontier fans per fan; the rim ring, the backdrop, the dim plates and the selection ring have no vertex data and compute their corners from `gl_VertexID`. Shared GLSL (`common.glsl`: the camera-relative transform of §7.2, `sinPrecise`, arc clamping; `palette.glsl`; `frag.glsl`) is prepended to each pass's source in TS, since GLSL has no `#include`. Highlight paths live in small dynamic buffers, re-uploaded only when their array changes.
- **The frame plan** (`render/plan.ts`) is one pure function, `planFrame(tiles, fans, params, size, passes) → { look, cmds, stats }`. Each `DrawCmd` names a pass, its vertex and instance counts, the tile or data it reads, its per-draw values and its blend mode. Every per-draw decision lives there: which tiles to skip at fade 0, `K` for arcs (128 for levels ≤ 3, else 16), the wide/narrow fan split, the tip cut, the leader alpha, the tree dim drawn before the highlights, skipped paths and rings, and the `FrameStats` count. The renderer only turns commands into GL calls (`execute`, `setBlend`), so the plan's behaviour is covered by `plan.test.ts` without a GPU. `Renderer` (`render/types.ts`) is the interface the scene draws through; `GpuTile` lets the plan and its tests work on tiles without knowing WebGL.
- **Readback:** the drawing buffer is not preserved, so `readPixels` (precision test, smoke test) and the reduced-motion crossfade's `drawImage` of the tree canvas run in the task that drew the frame; GL rows come bottom-up and `render/pixels.ts` flips them.
- **Instrumentation:** the `?debug` HUD shows the CPU frame time, and with `?debug` on, each frame waits for the GPU (a 1×1 `readPixels`; `gl.finish()` does not block in Chrome), so it includes GPU time. `__bench(n)` (`?shot`) is the average wall time of n frames waiting for the GPU after each. There is no separate GPU timer: Chrome does not expose `EXT_disjoint_timer_query_webgl2` without flags. `?passes=branches,arcs,…` draws only those passes (the plan filters them).
- **Frame times** (`__bench`, AMD iGPU through ANGLE GL, `SHOT_GPU=1`, ms; 2026-10-31): overview 3.6, animals 3.2, mammals 6.5, deep-homo 1.3, key-fungi 4.1, crumb-fly 1.5, hidpi-overview (2560×1440 @2) 7.8, reduced 4.0, mobile-overview (390×844 @2) 2.4, mid-l6.5-protists 5.8, deep-archaea 1.5, panel-homo 1.5, hover-path 7.6, precision 1.6. All within the 8 ms budget. SwiftShader is about 100× slower (160–800 ms) and only good for pictures.

---

## 8. Repository layout
```
species/
├─ CLAUDE.md                 agent conventions
├─ README.md                 what and why, quickstart, data licences, Docker and Coolify
├─ Makefile                  tasks (§9.1)
├─ go.mod / go.sum           module "species", go 1.27; modernc.org/sqlite
├─ .env.example              SPECIES_DATA_DIR SPECIES_STATIC_DIR PORT SPECIES_CONTACT SPECIES_PUBLIC_URL LOG_LEVEL
├─ Dockerfile, compose.yaml  image (§10) and a prod-like local run with ./data at /data
├─ cmd/species/main.go       subcommands: ingest | serve | healthcheck | version
├─ internal/
│  ├─ config/                flags + env for each subcommand, UserAgent, Endpoints (upstream base URLs)
│  ├─ tree/                  tree.go newick.go taxonomy.go groups.go layout.go lod.go
│  ├─ tiles/                 bucketing, encoder, decoder (for tests), gzip, tile flags
│  ├─ names/                 Fold and placeholder-name rules shared by db and vernacular
│  ├─ vernacular/            GBIF VernacularName reader
│  ├─ db/                    schema.sql cache.sql (go:embed), write, open, queries, search, cache
│  ├─ jsonfloat/             float types with the API's JSON number format ("1.0", "0.724")
│  ├─ enrich/                enrich doc html wikidata wikipedia gbif inat gate
│  ├─ enrich/enrichtest/     fixture-backed httptest mock of every upstream
│  ├─ server/                server.go (State, Router, Run), errors, static, gzip, logging, one file per route group
│  ├─ healthcheck/           `species healthcheck` for the Docker HEALTHCHECK
│  ├─ ingest/                orchestrates parse → layout → tiles → tree.db, and the report
│  └─ testutil/              fixture paths; minidb/ builds the mini tree.db for tests
├─ docs/                     this file, DESIGN.md, data-sources.md, tile-format.md,
│                            reference/1-5.png (inspiration frames)
├─ tests/fixtures/           mini.tre, mini_taxonomy.tsv, mini_vernacular.tsv, vernacular.tsv,
│                            golden_tile.bin, enrich/*.json (upstream samples); read by Go and Vitest
├─ data/                     gitignored: raw/, tree.db, cache.db, mini.db
└─ web/
   ├─ package.json  pnpm-lock.yaml  tsconfig.json  vite.config.ts (proxy /api → :3000)
   ├─ index.html, public/    favicon.svg, fallback.webp
   ├─ scripts/               shot.ts (§9.2), smoke.ts, pixeldiff.ts
   └─ src/                   §7.1
```
Go tests find the fixtures with `testutil.Fixture(name)` (through `runtime.Caller`), not `testdata/`, because the Vitest decoder test reads `tests/fixtures/golden_tile.bin` too.

**Mini fixture** (`tests/fixtures/mini.tre`, about 60 nodes): the real root id `ott93302`; all group roots (Metazoa, Fungi, Chloroplastida, Rhodophyta, Glaucophyta, Bacteria, Archaea) plus a protist under Eukaryota; Homo sapiens `ott770315` under a short Mammalia chain; one `mrcaott…` node; one monotypic chain; one polytomy of 8; and a matching `mini_taxonomy.tsv` with the header and the trailing `\t|\t`. `make ingest-mini` builds `data/mini.db` so the frontend can be developed without the real data.

---

## 9. Development workflow

### 9.1 Makefile
Tasks are plain Make targets (`make help` lists them). The Makefile reads an optional `.env`.

| Target | What it does |
|---|---|
| `fetch-data` | curl + tar the synth tree and OTT into `data/raw/` (URLs in §2.1) |
| `fetch-gbif` | backbone.zip into `data/raw/`, resumable through a `.part` file |
| `bin` | `CGO_ENABLED=0 go build -o bin/species ./cmd/species` |
| `ingest` | the full ingest into `data/tree.db` (common names when backbone.zip is present) |
| `ingest-mini` | the same on the fixtures, writing `data/mini.db` |
| `golden` | `UPDATE_GOLDEN=1 go test ./internal/ingest -run TestGoldenTile` |
| `server` / `server-mini` | `bin/species serve --data data [--db mini.db]` |
| `web` / `dev` | Vite dev server; both together (Ctrl+C stops both) |
| `test` | `go test ./...` + vitest |
| `check` | `gofmt -l .` empty, `go vet ./...`, `go test ./...`, `tsc --noEmit`, `vitest run` |
| `lint-design` | greps `web/src` for banned design tokens (DESIGN.md §9) |
| `shot` | `pnpm -C web shot` (needs a fresh web build and the server running) |
| `smoke` | builds, starts its own server on `SMOKE_PORT` (3077) on a temporary data copy, runs the Playwright smoke test |
| `build` | `pnpm -C web build` + `bin` |
| `docker` | `docker build -t species .` |

### 9.2 Visual QA loop
- **Run it with** `pnpm -C web shot [state…]` (`web/scripts/shot.ts`; Node 26 strips types natively). It shoots the server at `SHOT_BASE` (default `http://localhost:3000`, which serves `web/dist`, so build first).
- **Browser:** headless Chromium via Playwright. The default is SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`), so WebGL2 works without a GPU; `SHOT_GPU=1` uses the machine's GPU (`--use-angle=gl --enable-gpu --ignore-gpu-blocklist`) for real frame times.
- **Per state** it opens a URL (`?shot&n=…&v=…`), waits for `window.__renderIdle === true` (no pending tiles, no animation, fonts loaded, 2 quiet frames), and writes the PNG plus a JSON of stats (renderer, frame time, precision) next to it.
- **States** include `overview`, `animals`, `mammals`, `deep-homo` (1.png zoom), `panel-homo`, the search states, `mobile-…` at 390×844, `reduced`, the `locked-…` family (a name prefix picks every state that starts with it) and the free view states.
- **Diffs:** `SHOT_COMPARE=<dir>` diffs every shot against `<dir>/<state>.png` (`scripts/pixeldiff.ts`: a pixel is over when a channel differs by more than 16; a state fails above 0.5% over or a mean absolute difference above 1.0), writes heatmaps and `report.json` into `<out>/diff/` and exits 1 over the thresholds. Reruns on the same rasteriser are bit-identical, so any difference is real; SwiftShader and the iGPU differ from each other by 0.2–1.8% over, so compare like with like. The `precision` state is not pixel-diffed (its frame depends on when the screenshot lands); its test result is compared with `<dir>/precision.json`. `SHOT_QUERY='&…'` adds URL parameters, `SHOT_OUT=<dir>` moves the output.
- **Review:** screens are compared against `docs/reference/*.png` and the DESIGN.md banned-tells checklist.
- **Lint:** `make lint-design` greps `web/src/**/*.{css,ts}` for banned tokens (`text-shadow`, gradients, `filter: blur`, `border-radius:` > 16px, `Inter`, `Geist`, `JetBrains`, `Space Grotesk`, `Roboto`, and any `backdrop-filter` or `box-shadow` other than the glass tokens of DESIGN.md §2.3).

### 9.3 Tests
- **Go** (`go test ./...`, all offline): parser unit tests (Newick, taxonomy, vernacular); layout and LOD property tests on the mini tree and a random 10k-node tree (children inside the parent's arc, increasing tip angles, `r` increasing to 1.0 at tips, `level(child) ≥ level(parent)`, the span bound, a group for every tip); the tile codec and the FNV-1a vector; an FTS5 probe of the embedded SQLite; `internal/ingest` on the mini fixtures (the database, every node in exactly one tile at `(level, sectorOf(angle))`, the golden tile, and determinism); `internal/server` through `httptest` (every route, headers, gzip rules, static content types, JSON byte snapshots); enrichment parse functions on fixtures, plus mock-server tests (`enrichtest`) for cache hits with zero upstream calls, timeouts giving partial documents, the licence filter and the User-Agent.
- **TS (Vitest):** angle math, camera and rig round-trips, lod, golden tile decode, flyto, palette conversion against known OKLCH→hex values from DESIGN.md, labels and the card's pure parts, the URL, the frame plan (§7.13), canvas sizing and the precision comparison.
- **Playwright smoke test** (`make smoke`, not in `make check`; `web/scripts/smoke.ts`): load → the card on Homo sapiens → search "panthera onca" → Enter → card title "Panthera onca" and `n=ott42322` in the URL, with WebGL2 and on `?nowebgl`; the locked view's interactions (wheel zoom keeps the anchor's world point, a drag turns without zooming, Esc keeps the selection, reset, a click selects at the same zoom), free view, old link formats, the card's tabs at several sizes, a boot failure, and the motion run (`?tour=1.5`: a plain visit opens Homo sapiens at minimum zoom, the tour hops without adding history, a key stops it, a fling decays). Other runs use `?reduced`, so the scene can go idle. `SMOKE_PORT`, `SMOKE_DATA` and `SMOKE_DB` move its server. By default its data dir is a temporary scratch copy (`data/tree.db` linked in, `data/cache.db` copied, removed afterwards), so smoke runs never write `data/cache.db`.

---

## 10. Deploy (Coolify)
The step-by-step guide is in README "Deploy to Coolify"; this section is the design.
- **Build:** the Dockerfile build pack from the git repo, in three stages:
  1. `node:26-slim` + `npm i -g pnpm@12.15.0` (Node 26 no longer ships corepack) → `web/dist`. Dependencies install in their own cached layer; Playwright browsers are skipped.
  2. `golang:1.27-trixie`: `go mod download` in its own cached layer, then `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`, a fully static binary.
  3. `gcr.io/distroless/static-debian13`: CA certificates (enrichment calls the upstreams over HTTPS), tzdata and `/etc/passwd`, nothing else. The binary plus `web/dist`; runs as uid 10001. Entry point: `species serve --data /data --static /app/web/dist`.
  - **Size:** about 7 MB compressed and 19 MB unpacked, of which 12 MB is the binary.
- **Persistent volume** at `/data`, holding `tree.db` and `cache.db`. The image ships an empty `/data` owned by uid 10001 (copied from the build stage, since there is no shell to `mkdir`), so a named volume mounted there starts out writable for `cache.db`. Build `tree.db` locally (`make ingest`), upload it with `rsync` to the volume's host path, then restart; `dataVersion` busts the client caches. Ingest needs about 1.2 GB of RAM plus the raw data, so it does not run on the server.
- **Env:** `SPECIES_DATA_DIR=/data`, `SPECIES_STATIC_DIR=/app/web/dist`, `PORT=3000`, `LOG_LEVEL=info` (set in the image); `SPECIES_CONTACT=<email or contact page>` and `SPECIES_PUBLIC_URL=https://<domain>` (set in Coolify).
- **Healthcheck:** the image's `HEALTHCHECK` runs `species healthcheck`, a `net/http` client with a 3 s timeout that requests `GET /healthz` on `127.0.0.1:$PORT`, so the image needs no curl. An image `HEALTHCHECK` takes precedence over a check configured in the Coolify dashboard. Traefik passes `Content-Encoding` and `Cache-Control` through unchanged (verified with `curl -I`). Leave Coolify's gzip middleware off: the app compresses its own responses.
- **Compose:** `compose.yaml` mounts `./data` at `/data` and runs as `${UID:-1000}:${GID:-1000}`, so the server can write `cache.db` to a bind mount owned by the host user.
- **Startup:** if `tree.db` is missing, `serve` exits with a clear error naming the expected path.
