import { describe, expect, it } from 'vitest';
import { decodeTile } from './decode';
import { FAN_FADING, FAN_WORDS, buildFans } from './fans';
import { encodeTile } from './testTile';

const ROOT = 0xffffffff;

// Node 1 (level 0) has children ladderized by size: two small ones (levels 3
// and 2, undrawn at F = 1), then node 4 (level 1, drawn) and node 5 (level 0).
const level0 = decodeTile(
  encodeTile(0, 0, [
    { id: 0, parent: ROOT, angle: 1000, arcLo: 500, arcHi: 1500, r: 0.1, childLevel: 0 },
    { id: 1, parent: 0, angle: 500, arcLo: 100, arcHi: 900, r: 0.5, childLevel: 1 },
    { id: 5, parent: 1, angle: 900, tip: true },
    { id: 6, parent: 0, angle: 1500, arcLo: 1400, arcHi: 1600, r: 0.6, childLevel: 4 },
  ]),
);
const level1 = decodeTile(encodeTile(1, 0, [{ id: 4, parent: 1, angle: 700, tip: true }]));

function fans(data: Uint32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += FAN_WORDS) out.push([...data.slice(i, i + FAN_WORDS)]);
  return out;
}

describe('frontier fans', () => {
  it('fans out the undrawn prefix of children and frontier nodes', () => {
    const f = fans(buildFans([level0, level1], 1));
    const r05 = new Uint32Array(new Float32Array([0.5]).buffer)[0];
    const r06 = new Uint32Array(new Float32Array([0.6]).buffer)[0];
    // Node 1: [arc_lo, first drawn child (700)) solid; [700, 900) fading
    // with level 1, because only node 5 (level 0) is drawn below F.
    expect(f).toContainEqual([100, 700, r05, 0]);
    expect(f).toContainEqual([700, 900, r05, 0 | FAN_FADING]);
    // Node 6 has no drawn children: its whole arc is a fan.
    expect(f).toContainEqual([1400, 1600, r06, 0]);
    // The root's children are all drawn: no fan.
    expect(f.some((x) => x[0] === 500)).toBe(false);
    // Widest first.
    const spans = f.map((x) => (x[1] ?? 0) - (x[0] ?? 0));
    expect([...spans].sort((a, b) => b - a)).toEqual(spans);
  });

  it('ignores tiles above the full level', () => {
    const f = fans(buildFans([level0, level1], 0));
    expect(f).toContainEqual([100, 900, new Uint32Array(new Float32Array([0.5]).buffer)[0], 0]);
  });
});
