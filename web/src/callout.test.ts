import { describe, expect, it } from 'vitest';
import { LEADER_START_GAP, afterName, columnLead, leaderBoxes, leaderPath, leaderStart } from './callout';
import { layoutFor } from './layout';

const W = 2000;
const H = 1030;

describe('leaderStart', () => {
  const l = layoutFor(W, H);

  it('starts at an on-screen tip, with no arrow', () => {
    const s = leaderStart(l.anchor, l.anchor, l.anchor, l.card, W, H);
    expect(s.p).toEqual(l.anchor);
    expect(s.arrow).toBe(0);
  });

  it("starts at a clade's node, sliding to the rim as the node goes off screen", () => {
    // Node just off the left edge: the stem's first on-screen point.
    const near = leaderStart({ x: 8, y: 500 }, { x: 600, y: 500 }, l.anchor, l.card, W, H);
    expect(near.p.x).toBeLessThan(20);
    expect(near.arrow).toBe(0);
    // Node far off: at the rim, where the clade's tips are.
    const far = leaderStart({ x: -4000, y: 500 }, { x: 600, y: 500 }, l.anchor, l.card, W, H);
    expect(far.p).toEqual({ x: 600, y: 500 });
    expect(far.atRim).toBe(1);
    // Continuous in between.
    let prev = near.p.x;
    for (let x = 8; x > -400; x -= 4) {
      const s = leaderStart({ x, y: 500 }, { x: 600, y: 500 }, l.anchor, l.card, W, H);
      expect(Math.abs(s.p.x - prev)).toBeLessThan(16); // 1.5 × 588 px over 240 px, per 4 px step
      prev = s.p.x;
    }
  });

  it('points at an off-screen selection from the nearest edge, the arrow fading in', () => {
    const near = leaderStart({ x: 300, y: 985 }, { x: 300, y: 985 }, l.anchor, l.card, W, H);
    const far = leaderStart({ x: 300, y: 2000 }, { x: 300, y: 2000 }, l.anchor, l.card, W, H);
    // On the way from the anchor, at the free area's bottom (above the HUD band).
    expect(near.p.y).toBeCloseTo(H - 56, 9);
    expect(near.arrow).toBeGreaterThan(0);
    expect(near.arrow).toBeLessThan(1);
    expect(far.arrow).toBe(1);
    expect(far.toward.y).toBeGreaterThan(0.5);
  });

  it('moves continuously as the selection leaves the screen', () => {
    let prev = leaderStart({ x: 300, y: 960 }, { x: 300, y: 960 }, l.anchor, l.card, W, H);
    for (let y = 960; y <= 1200; y += 2) {
      const s = leaderStart({ x: 300, y }, { x: 300, y }, l.anchor, l.card, W, H);
      expect(Math.hypot(s.p.x - prev.p.x, s.p.y - prev.p.y)).toBeLessThanOrEqual(4); // the ray from the anchor sweeps along the edge
      expect(Math.abs(s.arrow - prev.arrow)).toBeLessThan(0.25);
      prev = s;
    }
  });

  it('never starts behind the card', () => {
    const s = leaderStart({ x: 1600, y: 200 }, { x: 1600, y: 200 }, l.anchor, l.card, W, H);
    const inCard = s.p.x > l.card.x0 - 8 && s.p.y < l.card.y1 + 8;
    expect(inCard).toBe(false);
    expect(s.arrow).toBeGreaterThan(0);
  });
});

describe('leaderPath', () => {
  const l = layoutFor(W, H);

  it('runs from the anchor up at 60° and square into the card (desktop)', () => {
    const { path, arrow } = leaderPath(leaderStart(l.anchor, l.anchor, l.anchor, l.card, W, H), l.card, false);
    expect(arrow).toBeNull();
    const [a, e, c] = path;
    if (!a || !e || !c) throw new Error('three points');
    // Starts just outside the ring, heading up and right.
    expect(Math.hypot(a.x - l.anchor.x, a.y - l.anchor.y)).toBeCloseTo(LEADER_START_GAP, 9);
    expect(Math.atan2(a.y - e.y, e.x - a.x)).toBeCloseTo(Math.PI / 3, 9);
    // Horizontal into the card's left edge, within its height.
    expect(e.y).toBe(c.y);
    expect(c.x).toBe(l.card.x0);
    expect(c.y).toBeGreaterThan(l.card.y0);
    expect(c.y).toBeLessThan(l.card.y1);
  });

  it('enters the bottom edge from below the card, and the top edge from above it', () => {
    const below = leaderPath(leaderStart({ x: 1600, y: 800 }, { x: 1600, y: 800 }, l.anchor, l.card, W, H), l.card, false).path;
    expect(below[below.length - 1]?.y).toBe(l.card.y1);
    const above = leaderPath(leaderStart({ x: 1600, y: -300 }, { x: 1600, y: -300 }, l.anchor, l.card, W, H), l.card, false).path;
    expect(above[above.length - 1]?.y).toBe(l.card.y0);
  });

  it('never crosses the card', () => {
    for (const p of [
      { x: 100, y: 100 },
      { x: 700, y: 30 },
      { x: 1200, y: 900 },
      { x: 3000, y: 500 },
      { x: -500, y: -500 },
    ]) {
      const { path } = leaderPath(leaderStart(p, p, l.anchor, l.card, W, H), l.card, false);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        if (!a || !b) continue;
        for (let t = 0.01; t < 0.99; t += 0.02) {
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          const inCard = x > l.card.x0 + 0.5 && x < l.card.x1 && y > l.card.y0 && y < l.card.y1 - 0.5;
          expect(inCard).toBe(false);
        }
      }
    }
  });

  it('goes up into the card bottom on a phone', () => {
    const m = layoutFor(390, 844);
    const { path } = leaderPath(leaderStart(m.anchor, m.anchor, m.anchor, m.card, 390, 844), m.card, true);
    const last = path[path.length - 1];
    const prev = path[path.length - 2];
    expect(last?.y).toBe(m.card.y1);
    expect(prev?.x).toBe(last?.x);
    expect(last?.x).toBeGreaterThan(m.card.x0);
    expect(last?.x).toBeLessThan(m.card.x1);
  });
});

describe('afterName', () => {
  it('moves an on-screen start past the name, but not an off-screen one', () => {
    const l = layoutFor(W, H);
    const on = leaderStart({ x: 600, y: 600 }, { x: 600, y: 600 }, l.anchor, l.card, W, H);
    expect(afterName(on, { x: 1, y: 0 }, 200, l.card, W, H).p).toEqual({ x: 800, y: 600 });
    const off = leaderStart({ x: 600, y: 3000 }, { x: 600, y: 3000 }, l.anchor, l.card, W, H);
    expect(afterName(off, { x: 1, y: 0 }, 200, l.card, W, H).p).toEqual(off.p);
  });
});

describe('leaderBoxes', () => {
  it('boxes long segments in short pieces, skipping the start', () => {
    const path = [
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ];
    const boxes = leaderBoxes(path, 2);
    expect(boxes.length).toBeGreaterThan(3);
    for (const b of boxes) expect(b.x1 - b.x0).toBeLessThan(30);
    for (const b of leaderBoxes(path, 2, 30)) expect(b.x1).toBeGreaterThan(20);
  });
});

describe('columnLead', () => {
  const l = layoutFor(W, H);
  const out = { x: 1, y: 0 };

  it('runs along the row past the name column before rising, so the rise clears every name', () => {
    const start = { p: { x: 900, y: 440 }, toward: { x: 0, y: 0 }, arrow: 0, atRim: 1 };
    const lead = columnLead(start, out, 200, l.card, false, W, H);
    expect(lead).toEqual({ x: 900 + 200 + 24, y: 440 });
    const path = leaderPath(start, l.card, false, lead).path;
    expect(path[0]).toEqual({ x: 900 + LEADER_START_GAP, y: 440 });
    expect(path[1]).toEqual(lead);
    // Every point after the lead is right of the column.
    for (const p of path.slice(1)) expect(p.x).toBeGreaterThanOrEqual(1124);
  });

  it('stops short of the card, and adds nothing off screen or with no column', () => {
    const start = { p: { x: 1100, y: 440 }, toward: { x: 0, y: 0 }, arrow: 0, atRim: 1 };
    const lead = columnLead(start, out, 2000, l.card, false, W, H);
    expect(lead?.x).toBe(l.card.x0 - 24 - 16);
    expect(columnLead(start, out, 0, l.card, false, W, H)).toBeNull();
    expect(columnLead({ ...start, arrow: 1 }, out, 200, l.card, false, W, H)).toBeNull();
  });
});
