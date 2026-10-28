import { describe, expect, it } from 'vitest';
import { PATH_WORDS, encodePath, pathSegments, tilePoints } from './path';
import { TileIndex } from './picking';
import { decodeTile } from './tiles/decode';
import { encodeTile } from './tiles/testTile';

describe('pathSegments', () => {
  it('walks each parent arc to the child, then out along the child', () => {
    const segs = pathSegments([
      { angle: 1000, r: 0.08 },
      { angle: 400, r: 0.3 },
      { angle: 700, r: 0.6 },
    ]);
    expect(segs).toEqual([
      { a0: 400, span: 600, r0: 0.08, r1: 0.08 },
      { a0: 400, span: 0, r0: 0.08, r1: 0.3 },
      { a0: 400, span: 300, r0: 0.3, r1: 0.3 },
      { a0: 700, span: 0, r0: 0.3, r1: 0.6 },
    ]);
  });

  it('skips the arc of a child on its parent angle (a monotypic step)', () => {
    const segs = pathSegments([
      { angle: 5, r: 0.1 },
      { angle: 5, r: 0.2 },
    ]);
    expect(segs).toEqual([{ a0: 5, span: 0, r0: 0.1, r1: 0.2 }]);
  });

  it('adds the first stem from startR and runs the last on to endR', () => {
    const segs = pathSegments([{ angle: 9, r: 0.9 }], 0.7, 1);
    expect(segs).toEqual([
      { a0: 9, span: 0, r0: 0.7, r1: 0.9 },
      { a0: 9, span: 0, r0: 0.9, r1: 1 },
    ]);
  });
});

describe('tilePoints', () => {
  const NONE = 0xffffffff;
  // 0 (root) → 1 → 2 (tip); a second tile holds only 1 and 2 (root not loaded).
  const nodes = [
    { id: 0, parent: NONE, angle: 100, r: 0.08, parentR: 0.08 },
    { id: 1, parent: 0, angle: 200, r: 0.5, parentR: 0.08 },
    { id: 2, parent: 1, angle: 250, r: 1, parentR: 0.5, tip: true },
  ];

  it('walks parent links up to the root', () => {
    const index = new TileIndex();
    index.update([decodeTile(encodeTile(0, 0, nodes))]);
    expect(tilePoints(index, 2, -1, 0)).toEqual({
      points: [
        { angle: 100, r: expect.closeTo(0.08, 6) as number },
        { angle: 200, r: 0.5 },
        { angle: 250, r: 1 },
      ],
      startR: expect.closeTo(0.08, 6) as number,
    });
  });

  it('stops where the tiles stop, keeping the top stem', () => {
    const index = new TileIndex();
    index.update([decodeTile(encodeTile(5, 0, nodes.slice(1)))]);
    const p = tilePoints(index, 2, -1, 0);
    expect(p?.points.map((x) => x.angle)).toEqual([200, 250]);
    expect(p?.startR).toBeCloseTo(0.08, 6);
  });

  it('draws a Homo sapiens subspecies at the species angle', () => {
    const index = new TileIndex();
    index.update([decodeTile(encodeTile(0, 0, nodes))]);
    expect(tilePoints(index, 2, 1, 222)?.points.at(-1)?.angle).toBe(222);
  });

  it('is null for a node that is not loaded', () => {
    expect(tilePoints(new TileIndex(), 7, -1, 0)).toBeNull();
  });
});

describe('encodePath', () => {
  it('packs angles as u32 and radii as f32', () => {
    const words = encodePath([{ a0: 2 ** 32 - 1, span: 7, r0: 0.25, r1: 0.5 }]);
    expect(words.length).toBe(PATH_WORDS);
    expect(words[0]).toBe(2 ** 32 - 1);
    expect(words[1]).toBe(7);
    const f = new Float32Array(words.buffer);
    expect([f[2], f[3]]).toEqual([0.25, 0.5]);
  });
});
