import { describe, expect, it } from 'vitest';
import {
  type Box,
  type Candidate,
  CollisionGrid,
  Fader,
  arcTextDirection,
  cull,
  fits,
  outsideBox,
  radialText,
  rotatedBox,
} from './labelLayout';
import { LABEL_FADE_MS, LABEL_HIDE_FIT } from './style';

const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
const cand = (key: string, priority: number, b: Box, fit = 1): Candidate => ({ key, priority, fit, boxes: [b] });

describe('CollisionGrid', () => {
  it('finds overlaps across cells and ignores touching edges', () => {
    const g = new CollisionGrid(32);
    g.add(box(10, 10, 100, 20));
    expect(g.hits(box(90, 15, 120, 30))).toBe(true);
    expect(g.hits(box(100, 10, 120, 20))).toBe(false); // touches, no overlap
    expect(g.hits(box(0, 30, 200, 40))).toBe(false);
    expect(g.hits(box(-50, -50, -40, -40))).toBe(false);
  });
});

describe('cull', () => {
  it('places by priority and drops colliding labels', () => {
    const won = cull(
      [cand('small', 10, box(0, 0, 50, 10)), cand('big', 100, box(40, 0, 90, 10)), cand('apart', 1, box(0, 50, 50, 60))],
      () => false,
      300,
    );
    expect([...won.keys()].sort()).toEqual(['apart', 'big']);
  });

  it('keeps a shown label against a slightly bigger newcomer (sticky)', () => {
    const cands = [cand('old', 10, box(0, 0, 50, 10)), cand('new', 15, box(40, 0, 90, 10))];
    expect([...cull(cands, () => false, 300).keys()]).toEqual(['new']);
    expect([...cull(cands, (k) => k === 'old', 300).keys()]).toEqual(['old']);
    // …but not against one with many times its priority.
    const big = [cand('old', 10, box(0, 0, 50, 10)), cand('new', 1000, box(40, 0, 90, 10))];
    expect([...cull(big, (k) => k === 'old', 300).keys()]).toEqual(['new']);
  });

  it('applies hysteresis: show at fit 1, hide below 0.85', () => {
    const c = [cand('a', 1, box(0, 0, 1, 1), 0.9)];
    expect(cull(c, () => false, 300).has('a')).toBe(false);
    expect(cull(c, () => true, 300).has('a')).toBe(true);
    expect(fits(LABEL_HIDE_FIT - 0.01, true)).toBe(false);
    expect(fits(1, false)).toBe(true);
  });

  it('respects obstacles and the label cap', () => {
    const obstacle = box(0, 0, 100, 100);
    expect(cull([cand('a', 1, box(50, 50, 60, 60))], () => false, 300, [obstacle]).size).toBe(0);
    const many = Array.from({ length: 500 }, (_, i) => cand(`k${i}`, i, box(i * 10, 0, i * 10 + 5, 5)));
    expect(cull(many, () => false, 300).size).toBe(300);
  });

  it('picks the first clear alternative, keeping clear of soft obstacles', () => {
    const bar = box(0, 20, 300, 24);
    const c: Candidate = {
      key: 'clade',
      priority: 1,
      fit: 1,
      boxes: [bar],
      alts: [[box(120, 0, 180, 18)], [box(10, 0, 70, 18)], [box(230, 0, 290, 18)]],
    };
    // A leader through the middle text spot sends it to the second.
    const leader = box(149, 0, 151, 60);
    expect(cull([c], () => false, 300, [], [leader]).get('clade')).toBe(1);
    // The leader does not block the bar itself.
    expect(cull([c], () => false, 300, [], [leader]).has('clade')).toBe(true);
    // Hard obstacles over every spot: no label.
    expect(cull([c], () => false, 300, [box(0, 0, 300, 18)]).has('clade')).toBe(false);
  });

  it('does not flicker while a label slowly loses room', () => {
    // A label shrinking in fit from 1.2 to 0.8 shows until it crosses 0.85,
    // and never turns back on while shrinking.
    const f = new Fader();
    const states: boolean[] = [];
    for (let fit = 1.2, t = 0; fit >= 0.8; fit -= 0.01, t += 16) {
      const won = cull([cand('a', 5, box(0, 0, 10, 10), fit)], (k) => f.shown(k), 300);
      f.update(t, ['a'], won);
      states.push(f.shown('a'));
    }
    const firstOff = states.indexOf(false);
    expect(firstOff).toBeGreaterThan(0);
    expect(states.slice(firstOff).every((s) => !s)).toBe(true);
  });
});

describe('Fader', () => {
  it('fades linearly over LABEL_FADE_MS and reports motion', () => {
    const f = new Fader();
    expect(f.update(0, ['a'], new Set(['a']))).toBe(true);
    expect(f.alpha('a')).toBe(0);
    f.update(LABEL_FADE_MS / 2, ['a'], new Set(['a']));
    expect(f.alpha('a')).toBeCloseTo(0.5);
    expect(f.update(LABEL_FADE_MS, ['a'], new Set(['a']))).toBe(false);
    expect(f.alpha('a')).toBe(1);
    // Losing: fades out, then is forgotten.
    f.update(LABEL_FADE_MS * 1.5, ['a'], new Set());
    expect(f.alpha('a')).toBeCloseTo(0.5);
    expect(f.shown('a')).toBe(false);
    f.update(LABEL_FADE_MS * 3, ['a'], new Set());
    expect(f.alpha('a')).toBe(0);
  });

  it('drops labels that are no longer candidates', () => {
    const f = new Fader();
    f.update(0, ['a'], new Set(['a']));
    f.update(1000, ['a'], new Set(['a']));
    f.update(1001, [], new Set());
    expect(f.alpha('a')).toBe(0);
  });
});

describe('placement helpers', () => {
  it('hangs text away from the circle', () => {
    // Right of the wheel: text starts at the anchor.
    expect(outsideBox(100, 50, 1, 0, 40, 10)).toEqual(box(100, 45, 140, 55));
    // Left: text ends at the anchor.
    expect(outsideBox(100, 50, -1, 0, 40, 10)).toEqual(box(60, 45, 100, 55));
    // Above (screen y down): centred, bottom at the anchor.
    expect(outsideBox(100, 50, 0, -1, 40, 10)).toEqual(box(80, 40, 120, 50));
  });

  it('bounds rotated boxes', () => {
    const b = rotatedBox(0, 0, 40, 10, Math.PI / 2);
    expect(b.x1 - b.x0).toBeCloseTo(10);
    expect(b.y1 - b.y0).toBeCloseTo(40);
  });

  it('keeps radial text upright', () => {
    expect(radialText(0)).toEqual({ rot: 0, align: 'left' });
    const left = radialText(Math.PI);
    expect(left.align).toBe('right');
    expect(Math.cos(left.rot)).toBeCloseTo(1);
  });

  it('runs arc text clockwise on top and counter-clockwise below', () => {
    const top = arcTextDirection(Math.PI / 2);
    expect(top.dir).toBe(-1);
    expect(top.rot(Math.PI / 2)).toBeCloseTo(0); // upright at the top
    const bottom = arcTextDirection(-Math.PI / 2);
    expect(bottom.dir).toBe(1);
    expect(bottom.rot(-Math.PI / 2)).toBeCloseTo(0);
  });

  it('reads vertical arc text bottom to top on both sides', () => {
    for (const phi of [0, 0.01, -0.01, Math.PI, Math.PI + 0.01, Math.PI - 0.01]) {
      const d = arcTextDirection(phi);
      // A glyph turned by −90°: its baseline runs up the screen.
      expect(Math.sin(d.rot(phi))).toBeCloseTo(-1, 3);
    }
  });
});
