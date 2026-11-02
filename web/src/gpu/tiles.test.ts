import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Tile, decodeTile, tileOffsets } from '../tiles/decode';
import { encodeTile } from '../tiles/testTile';
import { tileBindingBytes, tileCount, tileF32, tileU32, tileU8, tileWords } from './tiles';

const U32_FIELDS = ['id', 'parent', 'angle', 'arcLo', 'arcHi', 'leafCount', 'firstTip'] as const;
const F32_FIELDS = ['r', 'parentR'] as const;
const U8_FIELDS = ['group', 'flags', 'childLevel'] as const;

/** The words the GPU sees: the tile up to its names. */
function gpuWords(t: Tile): Uint32Array {
  return new Uint32Array(t.buffer, 0, tileBindingBytes(t) / 4);
}

describe('tileWords', () => {
  for (const n of [1, 2, 3, 4, 57, 1000]) {
    it(`matches tileOffsets for n = ${n}`, () => {
      const o = tileOffsets(n);
      const w = tileWords(n);
      for (const f of [...U32_FIELDS, ...F32_FIELDS]) expect(w[f] * 4).toBe(o[f]);
      for (const f of U8_FIELDS) expect(w[f]).toBe(o[f]);
    });
  }

  it('puts angle[i] at word 6 + 2n + i (plan §0)', () => {
    expect(tileWords(57).angle).toBe(6 + 2 * 57);
  });
});

describe('tileBindingBytes', () => {
  it('is nameOff, a multiple of 4 even when the u8 arrays end mid-word', () => {
    for (const n of [1, 2, 3, 4]) {
      const t = decodeTile(encodeTile(0, 0, Array.from({ length: n }, (_, i) => ({ id: i, parent: 0, angle: i }))));
      expect(tileBindingBytes(t)).toBe(t.offsets.nameOff);
      expect(tileBindingBytes(t) % 4).toBe(0);
    }
  });
});

/** Checks every field of every node through the WGSL mirrors against decode.ts. */
function expectMirrorsDecode(t: Tile): void {
  const words = gpuWords(t);
  expect(tileCount(words)).toBe(t.count);
  const w = tileWords(tileCount(words));
  for (let i = 0; i < t.count; i++) {
    for (const f of U32_FIELDS) expect(tileU32(words, w[f], i)).toBe(t[f][i]);
    for (const f of F32_FIELDS) expect(tileF32(words, w[f], i)).toBe(t[f][i]);
    for (const f of U8_FIELDS) expect(tileU8(words, w[f], i)).toBe(t[f][i]);
  }
}

describe('WGSL mirrors read tiles like decode.ts', () => {
  it('reads a hand-made tile (testTile.ts)', () => {
    const nodes = [
      { id: 7, parent: 0xffffffff, angle: 0, arcLo: 0, arcHi: 4000, leafCount: 3, r: 0, parentR: 0, childLevel: 1 },
      { id: 8, parent: 7, angle: 3000, arcLo: 2000, arcHi: 4000, leafCount: 2, firstTip: 1, r: 0.5, parentR: 0, childLevel: 2 },
      { id: 9, parent: 7, angle: 0, tip: true, r: 1, parentR: 0 },
      { id: 10, parent: 8, angle: 0xfffffff0, tip: true, r: 1, parentR: 0.5, firstTip: 1 },
      { id: 11, parent: 8, angle: 4000, tip: true, r: 1, parentR: 0.5, firstTip: 2 },
    ];
    const t = decodeTile(encodeTile(3, 5, nodes));
    expect(t.count).toBe(5);
    expectMirrorsDecode(t);
  });

  it('reads u8 values at every byte position within a word', () => {
    // childLevel 0..6 lands at all four byte lanes.
    const nodes = Array.from({ length: 7 }, (_, i) => ({ id: i, parent: 0, angle: i, childLevel: 200 + i }));
    const t = decodeTile(encodeTile(0, 0, nodes));
    expectMirrorsDecode(t);
  });

  it('reads the golden tile (n = 57)', () => {
    const bytes = readFileSync(new URL('../../../tests/fixtures/golden_tile.bin', import.meta.url));
    const t = decodeTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(t.count).toBe(57);
    expectMirrorsDecode(t);
  });
});
