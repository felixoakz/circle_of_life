// Tile bytes as a storage buffer (docs/plan-webgpu.md §0, "vertex pulling"):
// WebGPU vertex buffers need 4-byte strides, but tiles hold u8 arrays, so
// the shaders read `var<storage, read> tile: array<u32>` by index instead.
// These are the TS mirrors of `shaders/tile.wgsl`, so the index maths is
// tested against tiles/decode.ts.

import type { Tile } from '../tiles/decode';

/**
 * Where each array starts for a tile of `n` nodes: u32 and f32 arrays as
 * word indices, u8 arrays as byte indices (as tile.wgsl computes them
 * from `n = tile[3]`).
 */
export interface TileWords {
  id: number;
  parent: number;
  angle: number;
  arcLo: number;
  arcHi: number;
  leafCount: number;
  firstTip: number;
  r: number;
  parentR: number;
  /** Byte indices. */
  group: number;
  flags: number;
  childLevel: number;
}

export function tileWords(n: number): TileWords {
  // The header is 6 words; then 9 word arrays of n entries, then 3 byte arrays.
  const word = (k: number): number => 6 + k * n;
  const byte = (k: number): number => 24 + (36 + k) * n;
  return {
    id: word(0),
    parent: word(1),
    angle: word(2),
    arcLo: word(3),
    arcHi: word(4),
    leafCount: word(5),
    firstTip: word(6),
    r: word(7),
    parentR: word(8),
    group: byte(0),
    flags: byte(1),
    childLevel: byte(2),
  };
}

/** Node count from the header, as the shader reads it (word 3). */
export function tileCount(words: Uint32Array): number {
  return words[3] ?? 0;
}

/** `tileU32`: word `base + i`. */
export function tileU32(words: Uint32Array, base: number, i: number): number {
  return words[base + i] ?? 0;
}

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** `tileF32`: word `base + i` reinterpreted as f32 (WGSL `bitcast<f32>`). */
export function tileF32(words: Uint32Array, base: number, i: number): number {
  u32Scratch[0] = words[base + i] ?? 0;
  return f32Scratch[0] ?? 0;
}

/** `tileU8`: byte `byteBase + i`, as `(word >> (byte & 3) * 8) & 0xff`. */
export function tileU8(words: Uint32Array, byteBase: number, i: number): number {
  const b = byteBase + i;
  return ((words[b >> 2] ?? 0) >>> ((b & 3) * 8)) & 0xff;
}

/** Bytes of the tile the GPU needs: everything before the names (`nameOff`, a multiple of 4). */
export function tileBindingBytes(tile: Tile): number {
  return tile.offsets.nameOff;
}
