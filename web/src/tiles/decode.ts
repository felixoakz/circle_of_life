// Zero-copy tile decoder for the v2 binary format (docs/tile-format.md).
// Every array is a typed-array view into the fetched ArrayBuffer; the same
// buffer is uploaded to the GPU as-is, using the byte offsets below.

const MAGIC = 0x32545053; // "SPT2" read as a little-endian u32
const VERSION = 2;
const HEADER = 24;

export const FLAG_TIP = 1;
export const FLAG_NAMED = 2;
export const FLAG_SPECIES = 4;
export const FLAG_HOME = 8;

/** Byte offsets of each array inside the tile buffer (for vertex attributes). */
export interface TileOffsets {
  id: number;
  parent: number;
  angle: number;
  arcLo: number;
  arcHi: number;
  leafCount: number;
  firstTip: number;
  r: number;
  parentR: number;
  group: number;
  flags: number;
  childLevel: number;
  nameOff: number;
  names: number;
}

export interface Tile {
  buffer: ArrayBuffer;
  level: number;
  sector: number;
  count: number;
  internalCount: number;
  offsets: TileOffsets;
  id: Uint32Array;
  parent: Uint32Array;
  angle: Uint32Array;
  arcLo: Uint32Array;
  arcHi: Uint32Array;
  leafCount: Uint32Array;
  /** Rank of the clade's first tip: its tips are ranks firstTip .. firstTip + leafCount − 1. */
  firstTip: Uint32Array;
  r: Float32Array;
  parentR: Float32Array;
  group: Uint8Array;
  flags: Uint8Array;
  childLevel: Uint8Array;
  nameOff: Uint32Array;
  names: Uint8Array;
}

/** Byte offsets for a tile with `n` nodes (the layout table in tile-format.md). */
export function tileOffsets(n: number): TileOffsets {
  const u8End = HEADER + 39 * n;
  const nameOff = (u8End + 3) & ~3;
  return {
    id: HEADER,
    parent: HEADER + 4 * n,
    angle: HEADER + 8 * n,
    arcLo: HEADER + 12 * n,
    arcHi: HEADER + 16 * n,
    leafCount: HEADER + 20 * n,
    firstTip: HEADER + 24 * n,
    r: HEADER + 28 * n,
    parentR: HEADER + 32 * n,
    group: HEADER + 36 * n,
    flags: HEADER + 37 * n,
    childLevel: HEADER + 38 * n,
    nameOff,
    names: nameOff + 4 * (n + 1),
  };
}

export function decodeTile(buffer: ArrayBuffer): Tile {
  if (buffer.byteLength < HEADER) throw new Error('tile: shorter than its header');
  const head = new DataView(buffer);
  if (head.getUint32(0, true) !== MAGIC) throw new Error('tile: bad magic');
  const version = head.getUint8(4);
  if (version !== VERSION) throw new Error(`tile: unsupported version ${version}`);
  const level = head.getUint8(5);
  const sector = head.getUint32(8, true);
  const n = head.getUint32(12, true);
  const internalCount = head.getUint32(16, true);
  const namesLen = head.getUint32(20, true);
  const o = tileOffsets(n);
  if (buffer.byteLength !== o.names + namesLen) {
    throw new Error(`tile: length ${buffer.byteLength}, expected ${o.names + namesLen}`);
  }
  if (internalCount > n) throw new Error('tile: internal_count exceeds count');
  // Typed arrays use the platform's byte order; every browser is little-endian.
  return {
    buffer,
    level,
    sector,
    count: n,
    internalCount,
    offsets: o,
    id: new Uint32Array(buffer, o.id, n),
    parent: new Uint32Array(buffer, o.parent, n),
    angle: new Uint32Array(buffer, o.angle, n),
    arcLo: new Uint32Array(buffer, o.arcLo, n),
    arcHi: new Uint32Array(buffer, o.arcHi, n),
    leafCount: new Uint32Array(buffer, o.leafCount, n),
    firstTip: new Uint32Array(buffer, o.firstTip, n),
    r: new Float32Array(buffer, o.r, n),
    parentR: new Float32Array(buffer, o.parentR, n),
    group: new Uint8Array(buffer, o.group, n),
    flags: new Uint8Array(buffer, o.flags, n),
    childLevel: new Uint8Array(buffer, o.childLevel, n),
    nameOff: new Uint32Array(buffer, o.nameOff, n + 1),
    names: new Uint8Array(buffer, o.names, namesLen),
  };
}

const utf8 = new TextDecoder();

/** Scientific name of record `i`; empty for unnamed (mrca) nodes. */
export function tileName(tile: Tile, i: number): string {
  const start = tile.nameOff[i] ?? 0;
  const end = tile.nameOff[i + 1] ?? start;
  return utf8.decode(tile.names.subarray(start, end));
}
