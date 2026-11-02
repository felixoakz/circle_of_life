// Reading a tile straight from its bytes ("vertex pulling"). WebGL fed each
// node's fields in as vertex attributes; WebGPU vertex buffers need 4-byte
// strides, and a tile's group/flags/childLevel arrays are 1 byte per node.
// So the whole tile (everything before the names) is bound as a read-only
// storage buffer of u32 words, and the vertex shader indexes it with
// `instance_index` (one instance per node). gpu/tiles.ts mirrors this index
// maths in TS and is tested against tiles/decode.ts.
//
// Layout (docs/tile-format.md): a 6-word header (node count n = word 3),
// then 9 arrays of n words (id, parent, angle, arcLo, arcHi, leafCount,
// firstTip, r, parentR), then 3 arrays of n bytes (group, flags, childLevel).

// Group 2 changes per draw: the tile being drawn.
@group(2) @binding(0) var<storage, read> tile: array<u32>;

fn tileN() -> u32 {
  return tile[3];
}

// Word array k (0 = id … 8 = parentR), node i.
fn tileU32(k: u32, i: u32) -> u32 {
  return tile[6u + k * tileN() + i];
}

// Same, reinterpreting the bits as a float (r, parentR).
fn tileF32(k: u32, i: u32) -> f32 {
  return bitcast<f32>(tileU32(k, i));
}

// Byte array k (0 = group, 1 = flags, 2 = childLevel), node i: pick the
// word holding the byte, shift it down, mask it (little-endian).
fn tileU8(k: u32, i: u32) -> u32 {
  let b = 24u + (36u + k) * tileN() + i;
  return (tile[b >> 2u] >> ((b & 3u) * 8u)) & 0xffu;
}

fn tileParent(i: u32) -> u32 { return tileU32(1u, i); }
fn tileAngle(i: u32) -> u32 { return tileU32(2u, i); }
fn tileArcLo(i: u32) -> u32 { return tileU32(3u, i); }
fn tileArcHi(i: u32) -> u32 { return tileU32(4u, i); }
fn tileLeafCount(i: u32) -> u32 { return tileU32(5u, i); }
fn tileR(i: u32) -> f32 { return tileF32(7u, i); }
fn tileParentR(i: u32) -> f32 { return tileF32(8u, i); }
fn tileGroup(i: u32) -> u32 { return tileU8(0u, i); }
fn tileFlags(i: u32) -> u32 { return tileU8(1u, i); }
fn tileChildLevel(i: u32) -> u32 { return tileU8(2u, i); }
