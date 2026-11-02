import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { Flight, MAX_MS, MIN_MS, TURN_MAX_MS, TURN_MIN_MS, flightMs, interpolate, turnPath } from './flyto';
import { layoutFor } from './layout';
import { Rig } from './rig';

const SPAN = 900;

describe('interpolate (van Wijk–Nuij along the rim)', () => {
  // Minimum zoom, then a tip at the deepest zoom a little way round.
  const wide = { theta: 2, scale: 700 };
  const deep = { theta: 2.1, scale: 1.8e7 };

  it('starts and ends exactly at its endpoints', () => {
    for (const [from, to] of [
      [wide, deep],
      [deep, wide],
      [wide, { ...wide, scale: 7000 }],
      [deep, { theta: deep.theta + 1e-9, scale: deep.scale }],
    ] as const) {
      const path = interpolate(from, to, SPAN);
      expect(path.at(0)).toEqual(from);
      expect(path.at(1).scale).toBe(to.scale);
      expect(path.at(1).theta).toBeCloseTo(to.theta, 12);
      // And continuously so: a hair from either end is a hair from the pose.
      const near1 = path.at(1 - 1e-6);
      expect(Math.abs(near1.scale / to.scale - 1)).toBeLessThan(1e-6);
      expect(Math.abs(near1.theta - to.theta) * to.scale).toBeLessThan(0.01);
      const near0 = path.at(1e-6);
      expect(Math.abs(near0.scale / from.scale - 1)).toBeLessThan(1e-6);
    }
  });

  it('turns the short way round, across 0', () => {
    const path = interpolate({ theta: 6.2, scale: 1e5 }, { theta: 0.1, scale: 1e5 }, SPAN);
    for (let i = 0; i <= 20; i++) {
      const th = path.at(i / 20).theta;
      expect(th).toBeGreaterThanOrEqual(6.2 - 1e-12);
      expect(th).toBeLessThanOrEqual(2 * Math.PI + 0.1 + 1e-12);
    }
  });

  it('progresses monotonically, and only dives when the target is in view', () => {
    const path = interpolate(wide, deep, SPAN);
    let prevTheta = -Infinity;
    let prevScale = 0;
    for (let i = 0; i <= 200; i++) {
      const p = path.at(i / 200);
      expect(p.theta).toBeGreaterThanOrEqual(prevTheta - 1e-12);
      expect(p.scale).toBeGreaterThanOrEqual(prevScale);
      prevTheta = p.theta;
      prevScale = p.scale;
    }
  });

  it('zooms out and back in between two far-apart deep views', () => {
    const a = { theta: 1, scale: 1e6 };
    const b = { theta: 3, scale: 1e6 };
    const mid = interpolate(a, b, SPAN).at(0.5);
    // Halfway the view is wide enough to hold a good part of the way.
    expect(SPAN / mid.scale).toBeGreaterThan(2 / 4);
    expect(interpolate(a, b, SPAN).ms).toBe(MAX_MS);
  });

  it('clamps the duration to 600–2000 ms', () => {
    expect(flightMs(0)).toBe(MIN_MS);
    expect(flightMs(2)).toBe(1200);
    expect(flightMs(50)).toBe(MAX_MS);
    expect(interpolate(wide, deep, SPAN).ms).toBe(MAX_MS);
    expect(interpolate(wide, { ...wide, scale: 800 }, SPAN).ms).toBe(MIN_MS);
  });
});

describe('turnPath', () => {
  it('keeps the zoom and eases the angle', () => {
    const path = turnPath({ theta: 1, scale: 5000 }, { theta: 1.1, scale: 99 }, SPAN);
    expect(path.at(0.5).scale).toBe(5000);
    expect(path.at(0.5).theta).toBeCloseTo(1.05, 12);
    expect(path.at(1)).toEqual({ theta: 1.1, scale: 5000 });
    expect(path.ms).toBeGreaterThanOrEqual(TURN_MIN_MS);
    expect(path.ms).toBeLessThanOrEqual(TURN_MAX_MS);
  });
});

describe('Flight', () => {
  function rig(): Rig {
    const cam = new Camera(2_385_875);
    cam.setViewport(1440, 900, 1);
    const r = new Rig(cam);
    r.setLayout(layoutFor(1440, 900));
    r.set({ theta: 0.5, scale: r.minScale() });
    return r;
  }

  it('lands on the target pose, clamped to the zoom range', () => {
    const r = rig();
    const f = new Flight(r);
    f.fly({ theta: 0.6, scale: 1e30 }, { now: 0 });
    expect(f.step(100)).toBe(true);
    expect(f.step(1e6)).toBe(false);
    expect(r.theta).toBeCloseTo(0.6, 12);
    expect(r.scale).toBe(r.maxScale());
  });

  it('keeps the zoom on a turn', () => {
    const r = rig();
    const s = r.scale * 3;
    r.set({ theta: 0.5, scale: s });
    const f = new Flight(r);
    f.fly({ theta: 0.7, scale: r.maxScale() }, { now: 0, turnOnly: true });
    f.step(1e6);
    expect(r.scale).toBe(s);
    expect(r.theta).toBeCloseTo(0.7, 12);
  });

  it('cuts with reduced motion, snapshotting first', () => {
    const r = rig();
    const f = new Flight(r);
    const calls: string[] = [];
    f.reducedMotion = true;
    f.onCut = () => calls.push(`cut at ${r.theta.toFixed(1)}`);
    f.onEnd = () => calls.push('end');
    f.fly({ theta: 1.5, scale: r.scale });
    expect(calls).toEqual(['cut at 0.5', 'end']);
    expect(r.theta).toBeCloseTo(1.5, 12);
    expect(f.active()).toBe(false);
  });
});
