//! Tiles: the binary blobs the browser draws from (PLAN §3.6–3.7, and
//! `docs/tile-format.md`, which gives every byte offset).
//!
//! Every node lives in exactly one tile, keyed by `(level, sector)`: its LOD
//! level and the sector of that level containing its angle. [`build`] buckets
//! all nodes that way, [`encode`]s each bucket in the v2 format and gzips it;
//! [`decode`] reads a raw (ungzipped) tile back, for tests.
//!
//! The per-node values that tiles and `tree.db` share (flags, name, the home
//! node) are also defined here, so the two can never disagree.
//!
//! Concepts introduced here:
//! - writing numbers as little-endian bytes (`to_le_bytes`) and reading them
//!   back (`from_le_bytes`)
//! - turning a slice into a fixed-size array with `try_into`
//! - streaming compression through `std::io::Write` (flate2's `GzEncoder`)
//! - a hand-written FNV-1a hash (no extra crate for 6 hex digits)

use std::io::Write;

use anyhow::{Context, bail, ensure};
use flate2::Compression;
use flate2::write::GzEncoder;

use crate::tree::layout::Layout;
use crate::tree::taxonomy::Taxonomy;
use crate::tree::{Label, NO_PARENT, Tree, lod};

/// First four bytes of every tile.
pub const MAGIC: &[u8; 4] = b"SPT2";
/// Format version, byte 4.
pub const VERSION: u8 = 2;
/// Bytes before the first array.
pub const HEADER_LEN: usize = 24;
/// Number of 4-byte arrays (id … parent_r) before the three u8 arrays.
const U32_COLUMNS: usize = 9;

/// Homo sapiens. Its node gets [`FLAG_HOME`]; it is not a tip (it has two
/// subspecies), so the flag is on the species node itself.
pub const HOME_OTT: u32 = 770315;

// Flag bits (PLAN §3.7). Bits 4–7 are reserved and always 0; OTT's `extinct`
// flag is deliberately not carried (PLAN §2.2).
pub const FLAG_TIP: u8 = 1 << 0;
pub const FLAG_NAMED: u8 = 1 << 1;
pub const FLAG_SPECIES: u8 = 1 << 2;
pub const FLAG_HOME: u8 = 1 << 3;

/// One node as stored in a tile. Mirrors one row across the tile's arrays.
#[derive(Debug, Clone, PartialEq)]
pub struct TileNode {
    pub id: u32,
    pub parent: u32,
    pub angle: u32,
    pub arc_lo: u32,
    pub arc_hi: u32,
    pub leaf_count: u32,
    /// Rank of the clade's first tip; its tips are `first_tip .. first_tip +
    /// leaf_count`, so the client knows a clade's exact extent on the rim.
    pub first_tip: u32,
    pub r: f32,
    pub parent_r: f32,
    pub group: u8,
    pub flags: u8,
    pub child_level: u8,
    /// Scientific name; empty for `mrca…` nodes (they have none).
    pub name: String,
}

/// A decoded tile: internal nodes first, then tips, each run sorted by angle.
#[derive(Debug, Clone, PartialEq)]
pub struct Tile {
    pub level: u8,
    pub sector: u32,
    pub internal_count: u32,
    pub nodes: Vec<TileNode>,
}

/// A finished tile, ready for the `tiles` table.
#[derive(Debug)]
pub struct EncodedTile {
    pub level: u8,
    pub sector: u32,
    /// Node count, for logs.
    pub count: u32,
    /// Ungzipped size, for logs.
    pub raw_len: usize,
    /// The gzipped blob stored in `tree.db` and sent as-is to the browser.
    pub gz: Vec<u8>,
}

/// All tiles, plus a hash of their raw bytes for `dataVersion`.
#[derive(Debug)]
pub struct Tiles {
    /// Sorted by `(level, sector)`.
    pub tiles: Vec<EncodedTile>,
    /// FNV-1a over every raw tile in order; changes when any tile does.
    pub hash: u64,
}

/// Flags of the node with final id `id` (see the `FLAG_*` constants).
pub fn node_flags(tree: &Tree, taxonomy: &Taxonomy, layout: &Layout, id: usize) -> u8 {
    let node = layout.node[id] as usize;
    let mut flags = 0;
    if layout.is_tip(id) {
        flags |= FLAG_TIP;
    }
    if let Some(taxon) = &taxonomy.taxa[node] {
        flags |= FLAG_NAMED;
        if taxon.rank == "species" {
            flags |= FLAG_SPECIES;
        }
    }
    if tree.label[node] == Label::Ott(HOME_OTT) {
        flags |= FLAG_HOME;
    }
    flags
}

/// Final id of the home node (Homo sapiens), if the tree has it.
pub fn home_id(tree: &Tree, layout: &Layout) -> Option<usize> {
    (0..layout.len()).find(|&id| tree.label[layout.node[id] as usize] == Label::Ott(HOME_OTT))
}

/// Buckets every node into its tile, then encodes and gzips each tile.
pub fn build(tree: &Tree, taxonomy: &Taxonomy, layout: &Layout) -> anyhow::Result<Tiles> {
    // buckets[level][sector] = final ids in that tile. Levels have 1, 2, 4, …
    // sectors; 16,383 buckets in all for Lmax = 13, most of them small.
    let mut buckets: Vec<Vec<Vec<u32>>> = Vec::new();
    for level in 0..=layout.max_level {
        buckets.push(vec![Vec::new(); 1 << level]);
    }
    for id in 0..layout.len() {
        let level = layout.level[id];
        let sector = lod::sector_of(layout.angle[id], level);
        buckets[level as usize][sector as usize].push(id as u32);
    }

    let mut tiles = Vec::new();
    let mut hash = FNV_OFFSET;
    for (level, sectors) in buckets.iter().enumerate() {
        for (sector, ids) in sectors.iter().enumerate() {
            if ids.is_empty() {
                continue; // an empty tile is simply absent
            }
            let tile = make_tile(tree, taxonomy, layout, level as u8, sector as u32, ids);
            let raw = encode(&tile);
            hash = fnv1a(hash, &raw);
            tiles.push(EncodedTile {
                level: level as u8,
                sector: sector as u32,
                count: ids.len() as u32,
                raw_len: raw.len(),
                gz: gzip(&raw)?,
            });
        }
    }
    Ok(Tiles { tiles, hash })
}

/// Gathers the nodes `ids` into a [`Tile`] in the order the format wants.
fn make_tile(
    tree: &Tree,
    taxonomy: &Taxonomy,
    layout: &Layout,
    level: u8,
    sector: u32,
    ids: &[u32],
) -> Tile {
    let mut ids = ids.to_vec();
    // Internal nodes first (`false < true`), each run by angle; the id breaks
    // ties (a monotypic chain shares one angle) so the output is
    // deterministic.
    ids.sort_by_key(|&id| (layout.is_tip(id as usize), layout.angle[id as usize], id));

    let mut nodes = Vec::with_capacity(ids.len());
    let mut internal_count = 0;
    for &id in &ids {
        let i = id as usize;
        let parent = layout.parent[i];
        // The root has no parent; its parent_r is its own r, so its radial
        // segment has zero length.
        let parent_r = if parent == NO_PARENT {
            layout.r[i]
        } else {
            layout.r[parent as usize]
        };
        if !layout.is_tip(i) {
            internal_count += 1;
        }
        nodes.push(TileNode {
            id,
            parent,
            angle: layout.angle[i],
            arc_lo: layout.arc_lo[i],
            arc_hi: layout.arc_hi[i],
            leaf_count: layout.leaf_count[i],
            first_tip: layout.first_tip[i],
            r: layout.r[i],
            parent_r,
            group: layout.group[i],
            flags: node_flags(tree, taxonomy, layout, i),
            child_level: layout.child_level[i],
            name: taxonomy
                .name(layout.node[i] as usize)
                .unwrap_or("")
                .to_string(),
        });
    }
    Tile {
        level,
        sector,
        internal_count,
        nodes,
    }
}

/// Encodes a tile in binary format v2 (raw, not gzipped).
pub fn encode(tile: &Tile) -> Vec<u8> {
    let n = tile.nodes.len();
    let mut names_len = 0;
    for node in &tile.nodes {
        names_len += node.name.len();
    }
    let mut out = Vec::with_capacity(HEADER_LEN + n * 44 + 4 + names_len);

    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(tile.level);
    // LEARN: `to_le_bytes()` turns a number into its bytes, least significant
    // first ("little-endian"), e.g. `1u16` → `[1, 0]`. Fixing the byte order
    // in the format means the browser's `DataView`/typed arrays read the same
    // values whatever CPU wrote them. `extend_from_slice` appends them.
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&tile.sector.to_le_bytes());
    out.extend_from_slice(&(n as u32).to_le_bytes());
    out.extend_from_slice(&tile.internal_count.to_le_bytes());
    out.extend_from_slice(&(names_len as u32).to_le_bytes());

    // Column after column ("struct of arrays"), so the client can point a
    // vertex attribute straight at each array.
    for node in &tile.nodes {
        out.extend_from_slice(&node.id.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.parent.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.angle.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.arc_lo.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.arc_hi.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.leaf_count.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.first_tip.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.r.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(&node.parent_r.to_le_bytes());
    }
    for node in &tile.nodes {
        out.push(node.group);
    }
    for node in &tile.nodes {
        out.push(node.flags);
    }
    for node in &tile.nodes {
        out.push(node.child_level);
    }
    // The u8 arrays may leave us off a multiple of 4; the offsets array that
    // follows must start 4-byte aligned for a `Uint32Array` view.
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }

    let mut offset = 0u32;
    out.extend_from_slice(&offset.to_le_bytes());
    for node in &tile.nodes {
        offset += node.name.len() as u32;
        out.extend_from_slice(&offset.to_le_bytes());
    }
    for node in &tile.nodes {
        out.extend_from_slice(node.name.as_bytes());
    }
    out
}

/// Decodes a raw (ungzipped) v2 tile. Checks the magic, version and lengths.
pub fn decode(bytes: &[u8]) -> anyhow::Result<Tile> {
    ensure!(bytes.len() >= HEADER_LEN, "tile shorter than its header");
    ensure!(&bytes[0..4] == MAGIC, "bad tile magic {:?}", &bytes[0..4]);
    ensure!(bytes[4] == VERSION, "unsupported tile version {}", bytes[4]);
    let level = bytes[5];
    let sector = read_u32(bytes, 8);
    let n = read_u32(bytes, 12) as usize;
    let internal_count = read_u32(bytes, 16);
    let names_len = read_u32(bytes, 20) as usize;

    let u8_start = HEADER_LEN + U32_COLUMNS * 4 * n;
    let offsets_start = (u8_start + 3 * n).next_multiple_of(4);
    let names_start = offsets_start + 4 * (n + 1);
    if bytes.len() != names_start + names_len {
        bail!(
            "tile is {} bytes, header says {}",
            bytes.len(),
            names_start + names_len
        );
    }
    let names = &bytes[names_start..];

    // Start of array `k` among the 4-byte arrays.
    let column = |k: usize, i: usize| HEADER_LEN + k * 4 * n + 4 * i;
    let mut nodes = Vec::with_capacity(n);
    for i in 0..n {
        let name_lo = read_u32(bytes, offsets_start + 4 * i) as usize;
        let name_hi = read_u32(bytes, offsets_start + 4 * (i + 1)) as usize;
        ensure!(
            name_lo <= name_hi && name_hi <= names_len,
            "bad name offsets"
        );
        let name = std::str::from_utf8(&names[name_lo..name_hi]).context("name is not UTF-8")?;
        nodes.push(TileNode {
            id: read_u32(bytes, column(0, i)),
            parent: read_u32(bytes, column(1, i)),
            angle: read_u32(bytes, column(2, i)),
            arc_lo: read_u32(bytes, column(3, i)),
            arc_hi: read_u32(bytes, column(4, i)),
            leaf_count: read_u32(bytes, column(5, i)),
            first_tip: read_u32(bytes, column(6, i)),
            r: f32::from_bits(read_u32(bytes, column(7, i))),
            parent_r: f32::from_bits(read_u32(bytes, column(8, i))),
            group: bytes[u8_start + i],
            flags: bytes[u8_start + n + i],
            child_level: bytes[u8_start + 2 * n + i],
            name: name.to_string(),
        });
    }
    Ok(Tile {
        level,
        sector,
        internal_count,
        nodes,
    })
}

/// The little-endian u32 at `offset`. The caller has checked the length.
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    // LEARN: `bytes[a..b]` is a slice of unknown length (`&[u8]`), but
    // `from_le_bytes` wants exactly four bytes (`[u8; 4]`). `try_into()`
    // converts, failing if the length is wrong; here it is always 4, so
    // `unwrap()` cannot fire.
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// Gzips `raw` with the default level.
pub fn gzip(raw: &[u8]) -> anyhow::Result<Vec<u8>> {
    // LEARN: `GzEncoder` wraps any `Write` (here a `Vec<u8>`): bytes written
    // into it come out compressed into the inner writer. `finish()` flushes
    // the last block and the gzip trailer, then hands the `Vec` back.
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw)?;
    Ok(encoder.finish()?)
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

/// FNV-1a: a tiny, stable, non-cryptographic hash. Continue a hash by passing
/// the previous result as `hash` (start with [`FNV_OFFSET`]).
fn fnv1a(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= byte as u64;
        // LEARN: in debug builds `*` panics on overflow; `wrapping_mul` asks
        // for the modulo-2^64 result on purpose, which is what the hash wants.
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tile() -> Tile {
        let node = |id: u32, angle: u32, tip: bool, name: &str| TileNode {
            id,
            parent: if id == 0 { NO_PARENT } else { 0 },
            angle,
            arc_lo: angle,
            arc_hi: angle,
            leaf_count: 1,
            first_tip: id,
            r: 0.5 + id as f32 / 10.0,
            parent_r: 0.08,
            group: if id == 0 { 255 } else { 3 },
            flags: if tip { FLAG_TIP | FLAG_NAMED } else { 0 },
            child_level: if tip { 255 } else { 4 },
            name: name.to_string(),
        };
        Tile {
            level: 4,
            sector: 9,
            internal_count: 1,
            nodes: vec![
                node(0, 100, false, ""),
                node(1, 50, true, "Homo sapiens"),
                node(2, 150, true, "Onça ü"), // non-ASCII survives
            ],
        }
    }

    #[test]
    fn encode_decode_round_trip() {
        let tile = sample_tile();
        let raw = encode(&tile);
        assert_eq!(decode(&raw).unwrap(), tile);
    }

    #[test]
    fn header_and_alignment() {
        let raw = encode(&sample_tile());
        assert_eq!(&raw[0..4], b"SPT2");
        assert_eq!(raw[4], 2);
        assert_eq!(raw[5], 4);
        assert_eq!(read_u32(&raw, 8), 9);
        assert_eq!(read_u32(&raw, 12), 3);
        // n = 3: 24 + 9·12 = 132, u8 arrays end at 141, offsets start at 144.
        let names_len = "Homo sapiens".len() + "Onça ü".len();
        assert_eq!(read_u32(&raw, 20) as usize, names_len);
        assert_eq!(read_u32(&raw, 144), 0);
        assert_eq!(read_u32(&raw, 148), 0); // the internal node has no name
        assert_eq!(raw.len(), 144 + 4 * 4 + names_len);
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode(b"nope").is_err());
        let mut raw = encode(&sample_tile());
        raw[0] = b'X';
        assert!(decode(&raw).is_err());
        let mut raw = encode(&sample_tile());
        raw.pop();
        assert!(decode(&raw).is_err());
    }

    #[test]
    fn fnv1a_known_value() {
        // Published FNV-1a 64 test vector for "a".
        assert_eq!(fnv1a(FNV_OFFSET, b"a"), 0xaf63_dc4c_8601_ec8c);
    }
}
