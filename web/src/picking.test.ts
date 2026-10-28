import { describe, expect, it } from 'vitest';
import { RAD_PER_UNIT, tipAngle } from './angle';
import { type PickQuery, TileIndex, pick } from './picking';
import { decodeTile } from './tiles/decode';
import { encodeTile } from './tiles/testTile';

// 2^20 tips: one slot is 4096 angle units. At this scale a slot is 40 px.
const N = 2 ** 20;
const SLOT = 2 ** 32 / N;
const SCALE = 40 / (SLOT * RAD_PER_UNIT);
const t = (k: number): number => tipAngle(k, N);
const NONE = 0xffffffff;

// root 0 → A 1 (tips 2, 3), tip 4, Homo sapiens 5 (home, tips 6, 7 = its subspecies).
const HOME = 5;
const homeAngle = Math.floor((t(3) + t(4)) / 2);
const tile = decodeTile(
  encodeTile(0, 0, [
    { id: 0, parent: NONE, angle: t(2), arcLo: (t(0) + t(1)) / 2, arcHi: homeAngle, r: 0.08, parentR: 0.08, leafCount: 6 },
    { id: 1, parent: 0, angle: (t(0) + t(1)) / 2, arcLo: t(0), arcHi: t(1), r: 0.5, parentR: 0.08, leafCount: 2 },
    { id: HOME, parent: 0, angle: homeAngle, arcLo: t(3), arcHi: t(4), r: 0.9, parentR: 0.08, leafCount: 2, firstTip: 3 },
    { id: 2, parent: 1, angle: t(0), r: 1, parentR: 0.5, tip: true },
    { id: 3, parent: 1, angle: t(1), r: 1, parentR: 0.5, tip: true },
    { id: 4, parent: 0, angle: t(2), r: 1, parentR: 0.08, tip: true },
    { id: 6, parent: HOME, angle: t(3), r: 1, parentR: 0.9, tip: true },
    { id: 7, parent: HOME, angle: t(4), r: 1, parentR: 0.9, tip: true },
  ]),
);

function q(theta: number, rho: number, extra: Partial<PickQuery> = {}): PickQuery {
  return {
    theta,
    rho,
    scale: SCALE,
    level: 13,
    tipCount: N,
    homeId: HOME,
    homeAngle,
    tolPx: 4,
    rimInPx: 120,
    rimOutPx: 14,
    ...extra,
  };
}

/** World radius `px` device px inside (−) or outside (+) the rim. */
const rim = (px: number): number => 1 + px / SCALE;

describe('pick: tips in the rim zone', () => {
  it('finds the nearest tip by angle on its bar', () => {
    expect(pick([tile], q(t(0) + 300, rim(-20)))?.id).toBe(2);
    expect(pick([tile], q(t(1) - 300, rim(-100)))?.id).toBe(3);
    expect(pick([tile], q(t(2) + 1800, rim(5)))?.id).toBe(4);
  });

  it('measures the distance in px along the rim', () => {
    const hit = pick([tile], q(t(0) + SLOT / 4, rim(-10)));
    expect(hit?.distPx).toBeCloseTo(10, 6);
  });

  it('maps either Homo sapiens subspecies, and the merged bar, to Homo sapiens', () => {
    expect(pick([tile], q(t(3), rim(-30)))?.id).toBe(HOME);
    expect(pick([tile], q(t(4) + 100, rim(-30)))?.id).toBe(HOME);
    expect(pick([tile], q(homeAngle, rim(-30)))?.id).toBe(HOME);
  });

  it('leaves the rim zone alone further in', () => {
    // 200 px inside the rim and between two tips' lines: nothing.
    expect(pick([tile], q(t(0) + SLOT / 2, rim(-200)))).toBeNull();
  });
});

describe('pick: lines', () => {
  it('hits a radial segment within the tolerance, not beyond', () => {
    const px = (p: number): number => p / (SCALE * 0.7 * RAD_PER_UNIT);
    expect(pick([tile], q(t(2) + px(3), 0.7))?.id).toBe(4);
    expect(pick([tile], q(t(2) + px(6), 0.7))).toBeNull();
  });

  it('hits an arc between its children', () => {
    const between = t(0) + SLOT / 4;
    expect(pick([tile], q(between, 0.5 + 2 / SCALE))?.id).toBe(1);
  });

  it('prefers the deeper node where lines meet', () => {
    // A's stem ends where its arc and its children's stems begin.
    expect(pick([tile], q((t(0) + t(1)) / 2, 0.5))?.id).toBe(1);
    expect(pick([tile], q(t(0), 0.5 + 1 / SCALE))?.id).toBe(2);
  });

  it('runs a frontier node on to the rim while its children are not drawn', () => {
    const frontier = decodeTile(
      encodeTile(3, 0, [
        { id: 9, parent: 0, angle: t(10), arcLo: t(8), arcHi: t(12), r: 0.6, parentR: 0.08, childLevel: 9, leafCount: 5, firstTip: 8 },
      ]),
    );
    expect(pick([frontier], q(t(10), 0.8, { level: 8 }))?.id).toBe(9);
    expect(pick([frontier], q(t(10), 0.8, { level: 9 }))).toBeNull();
    // In the rim zone it owns all its tips' angles (the spike and fur).
    expect(pick([frontier], q(t(8), rim(3), { level: 8 }))?.id).toBe(9);
    expect(pick([frontier], q(t(13), rim(3), { level: 8 }))).toBeNull();
  });
});

describe('pick: level of detail', () => {
  it('ignores tiles above the view level', () => {
    const deep = { ...tile, level: 9 };
    expect(pick([deep], q(t(0), rim(-20), { level: 8 }))).toBeNull();
    expect(pick([deep], q(t(0), rim(-20), { level: 9 }))?.id).toBe(2);
  });
});

describe('TileIndex', () => {
  it('finds loaded nodes by id and rebuilds when the tiles change', () => {
    const index = new TileIndex();
    index.update([tile]);
    expect(index.get(3)?.index).toBe(4);
    expect(index.get(42)).toBeUndefined();
    index.update([]);
    expect(index.get(3)).toBeUndefined();
  });
});
