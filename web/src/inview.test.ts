import { describe, expect, it } from 'vitest';
import { TAU } from './angle';
import { Camera } from './camera';
import { circleInRect, tipsInArc, tipsInView } from './inview';

/** Scale (px per world unit) at which the whole wheel fits a 1440×900 screen. */
const WHEEL = 360;

const total = (arcs: { len: number }[]): number => arcs.reduce((s, a) => s + a.len, 0);

describe('circleInRect', () => {
  it('sees the whole circle when it fits, none when it is outside', () => {
    expect(total(circleInRect(50, 50, 10, 100, 100))).toBeCloseTo(TAU);
    expect(circleInRect(500, 500, 10, 100, 100)).toEqual([]);
    // A circle around the whole screen never touches it.
    expect(circleInRect(50, 50, 1000, 100, 100)).toEqual([]);
  });

  it('cuts a circle centred on an edge in half', () => {
    // Centre on the left edge: the right half (−π/2…π/2) is inside.
    const arcs = circleInRect(0, 50, 20, 100, 100);
    expect(total(arcs)).toBeCloseTo(Math.PI);
  });
});

describe('tipsInArc', () => {
  it('counts tips at (k + ½)·2π/n', () => {
    const n = 8;
    const slot = TAU / n;
    expect(tipsInArc({ lo: 0, len: TAU }, n)).toBe(8);
    expect(tipsInArc({ lo: 0, len: slot }, n)).toBe(1);
    expect(tipsInArc({ lo: slot * 0.6, len: slot * 0.8 }, n)).toBe(0);
    // Wraps through 0.
    expect(tipsInArc({ lo: TAU - slot, len: 2 * slot }, n)).toBe(2);
    expect(tipsInArc({ lo: -slot, len: 2 * slot }, n)).toBe(2);
  });
});

describe('tipsInView', () => {
  it('counts every tip on the whole wheel, and none off the rim', () => {
    const cam = new Camera(2_385_875);
    cam.setViewport(1440, 900, 1);
    cam.scale = WHEEL; // the whole wheel, centred
    expect(tipsInView(cam, cam.tipCount)).toBe(cam.tipCount);
    cam.scale = WHEEL * 20;
    cam.setCentre(0.2, 0);
    expect(tipsInView(cam, cam.tipCount)).toBeNull();
  });

  it('matches the tip spacing at max zoom', () => {
    const n = 2_385_875;
    const cam = new Camera(n);
    cam.setViewport(1440, 900, 1);
    cam.scale = cam.maxScale(); // 48 px between tips
    // Rim running vertically through the screen centre: 900 px of it visible.
    cam.angle = 1.234;
    cam.r = 1;
    cam.rot = -cam.angle;
    const count = tipsInView(cam, n) ?? 0;
    expect(count).toBeGreaterThanOrEqual(Math.floor(900 / 48));
    expect(count).toBeLessThanOrEqual(Math.ceil(900 / 48) + 1);
  });
});
