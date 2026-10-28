# Tile binary format v2

Mirror of PLAN §3.7, with exact byte offsets. The encoder and a reference decoder are in `src/tiles.rs`; the TypeScript decoder (P5) must agree with them byte for byte on `tests/fixtures/golden_tile.bin`.

## Container
- One tile holds every node whose LOD level is `level` and whose angle lies in sector `sector` of that level (`sector = level == 0 ? 0 : angle >>> (32 - level)`). Each node is in exactly one tile.
- Stored gzipped in `tree.db` (`tiles.data`) and served with `Content-Encoding: gzip`, so the browser's `fetch` hands over the raw bytes below.
- An empty tile is not stored; the API returns `204`.
- All numbers are **little-endian**. Every u32/f32 array starts at an offset that is a multiple of 4, so the client can view it directly as a `Uint32Array`/`Float32Array` or point a vertex attribute at it.

## Layout
`n` = `count`. `A = 24 + 39·n` is where the u8 arrays end; `O = A` rounded up to a multiple of 4.

| Offset | Size | Type | Field | Notes |
|---|---|---|---|---|
| 0 | 4 | bytes | magic | ASCII `SPT2` |
| 4 | 1 | u8 | version | `2` |
| 5 | 1 | u8 | level | 0..=Lmax (13 on the full tree) |
| 6 | 2 | u16 | reserved | `0` |
| 8 | 4 | u32 | sector | 0..2^level |
| 12 | 4 | u32 | count | `n`, nodes in the tile |
| 16 | 4 | u32 | internal_count | internal nodes come first |
| 20 | 4 | u32 | names_len | bytes in the names block |
| 24 | 4n | u32[n] | id | pre-order id, `== nodes.id`; `/api/nodes/{id}` |
| 24 + 4n | 4n | u32[n] | parent | parent's id; `0xFFFFFFFF` for the root |
| 24 + 8n | 4n | u32[n] | angle | fixed point, `θ = angle / 2^32 · 2π` |
| 24 + 12n | 4n | u32[n] | arc_lo | first child's angle; `== angle` for tips |
| 24 + 16n | 4n | u32[n] | arc_hi | last child's angle; `== angle` for tips |
| 24 + 20n | 4n | u32[n] | leaf_count | tips in the clade (a tip counts 1) |
| 24 + 24n | 4n | u32[n] | first_tip | rank (0-based, in angle order) of the clade's first tip; its tips are ranks `first_tip .. first_tip + leaf_count − 1` (see below) |
| 24 + 28n | 4n | f32[n] | r | radius, 0.08 at the root, 1.0 at tips |
| 24 + 32n | 4n | f32[n] | parent_r | parent's `r`; the root uses its own `r` (a zero-length segment) |
| 24 + 36n | n | u8[n] | group | 0 Animals, 1 Fungi, 2 Plants, 3 Protists, 4 Bacteria, 5 Archaea, 255 mixed |
| 24 + 37n | n | u8[n] | flags | see below |
| 24 + 38n | n | u8[n] | child_level | lowest level among the children; 255 for tips |
| A | O − A | | padding | zero bytes (0–3) |
| O | 4(n+1) | u32[n+1] | name_off | node `i`'s name is `names[name_off[i] .. name_off[i+1]]`; `name_off[0] = 0`, `name_off[n] = names_len` |
| O + 4(n+1) | names_len | bytes | names | UTF-8, no separators, no terminator |

The tile ends right after `names`: its length is exactly `O + 4(n+1) + names_len` (no trailing padding). The decoder rejects any other length.

## Record order
Records `0 .. internal_count` are internal nodes, records `internal_count .. n` are tips. Each run is sorted by `angle` ascending, ties by `id` ascending (a monotypic chain shares one angle). So the arc pass draws `instanceCount = internal_count`, and picking can binary-search the tips by angle.

## Tip extent (`first_tip`, new in v2)
A clade's tips are contiguous on the rim, and tip `k` sits at `angle = ((2k + 1) · 2^31) / N` (PLAN §3.3). So a clade's exact extent on the rim is from the angle of tip `first_tip` to that of tip `first_tip + leaf_count − 1`, with no tile walk. `[arc_lo, arc_hi]` is not that: it runs between the first and last *children's* midpoints, which can stop well short (e.g. *Pan*, whose arc ends at *Pan troglodytes*' midpoint, the middle of its five subspecies). For a tip, `first_tip` is its own rank.

## Flags (u8)
| Bit | Mask | Meaning |
|---|---|---|
| 0 | 0x01 | tip (no children) |
| 1 | 0x02 | named: the node has an OTT taxonomy name (every `ott…` node; never an `mrca…` node) |
| 2 | 0x04 | species rank (OTT rank is exactly `species`) |
| 3 | 0x08 | home: Homo sapiens, `ott770315`. In the real tree it has two subspecies, so it is an internal node; the flag sits on the species node itself, not on a tip. Exactly one node has it. |
| 4–7 | | reserved, always 0. OTT's `extinct` flag is deliberately not carried (PLAN §2.2). |

## Names
- A named node's entry is its OTT scientific name, e.g. `Homo sapiens`.
- `mrca…` nodes have no name: their entry is the **empty string** (`name_off[i] == name_off[i+1]`). The client titles them from `/api/nodes/{id}` ("Unnamed clade within …").

## Example
The golden tile (`tests/fixtures/golden_tile.bin`) is the single tile `(0, 0)` of the mini fixture tree: 57 nodes (27 internal, 30 tips), so the u8 arrays end at `24 + 39·57 = 2247`, padding is 1 byte and `name_off` starts at 2248.

## Regenerating the golden tile
`cargo test --test ingest golden_tile` builds the mini database and fails if tile `(0, 0)` differs from the fixture. After a deliberate format or fixture change run:

```
make golden        # UPDATE_GOLDEN=1 cargo test --test ingest golden_tile
```

and update the TypeScript decoder test expectations if needed.

## Versioning
Any change to this layout bumps `version` (byte 4) and the magic's digit, and goes through `make golden`. Tile URLs carry the data version (`/api/v/{ver}/tiles/…`), so clients never mix tiles from two ingests.
