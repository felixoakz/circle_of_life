import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { Flight, MAX_MS, MIN_MS, type Pose, cladePose, flightMs, interpolate, wheelPose } from './flyto';

const viewport = { width: 1440, height: 900 };

/** How far along the segment from → to a pose's centre is (0 at from, 1 at to). */
function along(from: Pose, to: Pose, p: Pose): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return ((p.x - from.x) * dx + (p.y - from.y) * dy) / (dx * dx + dy * dy);
}

describe('interpolate (van Wijk–Nuij)', () => {
  // The whole wheel, then Homo sapiens' tip at the deepest zoom.
  const overview = { x: 0, y: -0.05, scale: 400 };
  const deep = { x: Math.cos(2.1), y: Math.sin(2.1), scale: 1.8e7 };

  it('starts and ends exactly at its endpoints', () => {
    for (const [from, to] of [
      [overview, deep],
      [deep, overview],
      [overview, { ...overview, scale: 4000 }],
      [deep, { x: deep.x + 1e-6, y: deep.y, scale: deep.scale }],
    ] as const) {
      const path = interpolate(from, to, viewport);
      expect(path.at(0)).toEqual(from);
      expect(path.at(1)).toEqual(to);
      // And continuously so: a hair from either end is a hair from the pose.
      const near1 = path.at(1 - 1e-6);
      expect(Math.abs(near1.scale / to.scale - 1)).toBeLessThan(1e-6);
      expect(Math.hypot(near1.x - to.x, near1.y - to.y) * to.scale).toBeLessThan(0.01);
      const near0 = path.at(1e-6);
      expect(Math.abs(near0.scale / from.scale - 1)).toBeLessThan(1e-6);
    }
  });

  it('progresses monotonically: the centre only moves forward, the zoom only one way on a dive', () => {
    const path = interpolate(overview, deep, viewport);
    let prevAlong = -Infinity;
    let prevScale = 0;
    for (let i = 0; i <= 200; i++) {
      const p = path.at(i / 200);
      const a = along(overview, deep, p);
      expect(a).toBeGreaterThanOrEqual(prevAlong - 1e-12);
      // The target is in view at the start, so this is a pure dive.
      expect(p.scale).toBeGreaterThanOrEqual(prevScale);
      prevAlong = a;
      prevScale = p.scale;
    }
  });

  it('zooms out and back in between two far-apart deep views', () => {
    const a = { x: Math.cos(1), y: Math.sin(1), scale: 1e6 };
    const b = { x: Math.cos(3), y: Math.sin(3), scale: 1e6 };
    const path = interpolate(a, b, viewport);
    const mid = path.at(0.5);
    // Halfway the view is wide enough to hold both ends.
    expect(1440 / 2 / mid.scale).toBeGreaterThan(Math.hypot(b.x - a.x, b.y - a.y) / 4);
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const t = along(a, b, path.at(i / 100));
      expect(t).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = t;
    }
    expect(path.ms).toBe(MAX_MS);
  });

  it('clamps the duration to 600–2000 ms, growing with the path length', () => {
    expect(flightMs(0)).toBe(MIN_MS);
    expect(flightMs(0.5)).toBe(MIN_MS);
    expect(flightMs(2)).toBe(1200);
    expect(flightMs(50)).toBe(MAX_MS);
    // A long dive is capped; a short hop takes the minimum.
    expect(interpolate(overview, deep, viewport).ms).toBe(MAX_MS);
    expect(interpolate(overview, { ...overview, scale: 500 }, viewport).ms).toBe(MIN_MS);
    const pan = interpolate(overview, { ...overview, x: 2 * (900 / 400) }, viewport).ms;
    expect(pan).toBeGreaterThan(MIN_MS);
    expect(pan).toBeLessThan(MAX_MS);
  });

  it('handles a zero-length flight', () => {
    const path = interpolate(overview, overview, viewport);
    expect(path.ms).toBe(MIN_MS);
    expect(path.at(0.5)).toEqual(overview);
  });
});

describe('cladePose', () => {
  const cam = new Camera(2_385_875);
  cam.setViewport(1440, 900, 1);

  it('frames wide clades with the whole wheel', () => {
    expect(cladePose(cam, 0, 4, 0.1)).toEqual(wheelPose(cam));
  });

  it('frames a small clade at the rim', () => {
    const p = cladePose(cam, 1, 1.01, 0.5);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0.95);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1);
    // The arc (0.01 rad of rim) spans a good part of the screen.
    expect(0.01 * p.scale).toBeGreaterThan(200);
    expect(0.01 * p.scale).toBeLessThan(900);
  });

  it('never zooms past the maximum', () => {
    expect(cladePose(cam, 1, 1, 0.99).scale).toBeLessThanOrEqual(cam.maxScale());
  });
});

describe('Flight', () => {
  const setup = (): { cam: Camera; f: Flight } => {
    const cam = new Camera(1000);
    cam.setViewport(800, 600, 1);
    cam.fit();
    return { cam, f: new Flight(cam) };
  };

  it('reaches its target and stops; cancel stops it', () => {
    const { cam, f } = setup();
    const ends: number[] = [];
    f.onEnd = (now) => ends.push(now);
    const target = { x: 0.5, y: 0.5, scale: cam.fitScale() * 4 };
    f.fly(target, { now: 0 });
    expect(f.step(100)).toBe(true);
    expect(f.step(5000)).toBe(false);
    expect(ends).toEqual([5000]);
    expect(cam.centre().x).toBeCloseTo(0.5, 9);
    expect(cam.scale).toBeCloseTo(target.scale, 6);
    f.fly({ x: 0, y: 0, scale: cam.fitScale() }, { now: 0 });
    f.cancel(50);
    expect(ends).toEqual([5000, 50]);
    expect(f.step(100)).toBe(false);
  });

  it('turns to the predicted rotation the short way, monotonically', () => {
    const { cam, f } = setup();
    cam.rot = 3;
    f.endRotation = () => -3; // 0.28 rad further on, not 6 rad back
    f.fly({ x: 0.2, y: 0, scale: cam.fitScale() * 2 }, { now: 0 });
    let prev = cam.rot;
    for (let t = 0; t <= 2000; t += 50) {
      f.step(t);
      expect(cam.rot).toBeGreaterThanOrEqual(prev);
      prev = cam.rot;
    }
    expect(cam.rot).toBeCloseTo(-3 + 2 * Math.PI, 12);
  });

  it('cuts under reduced motion, with the snapshot hook first', () => {
    const { cam, f } = setup();
    f.reducedMotion = true;
    const calls: string[] = [];
    f.onCut = () => calls.push(`cut at ${Math.abs(cam.centre().x).toFixed(1)}`);
    f.onEnd = () => calls.push('end');
    f.endRotation = () => 1;
    f.fly({ x: 0.3, y: 0, scale: cam.fitScale() * 2 });
    expect(f.active()).toBe(false);
    expect(calls).toEqual(['cut at 0.0', 'end']);
    expect(cam.centre().x).toBeCloseTo(0.3, 9);
    expect(cam.rot).toBe(1);
  });
});
