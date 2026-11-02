import { describe, expect, it } from 'vitest';
import { TAU } from './angle';
import { Camera } from './camera';
import { layoutFor } from './layout';
import { Rig, driftShare, focusAngle, wrapAngle } from './rig';
import { TURN_SPACING } from './style';

const N = 2_385_875;

function rig(w = 2000, h = 1030, dpr = 1): Rig {
  const cam = new Camera(N);
  cam.setViewport(w * dpr, h * dpr, dpr);
  const r = new Rig(cam);
  r.setLayout(layoutFor(w, h));
  r.set({ theta: 1.3, scale: r.minScale() });
  return r;
}

/** Screen position (device px) of the rim point at world angle `theta`. */
function rimAt(r: Rig, theta: number): { x: number; y: number } {
  return r.camera.polarToScreen(theta, 1);
}

describe('driftShare', () => {
  it('runs 0 → 1 over the whole log range, half way at the geometric middle', () => {
    expect(driftShare(100, 100, 1e6)).toBe(0);
    expect(driftShare(1e4, 100, 1e6)).toBeCloseTo(0.5, 12);
    expect(driftShare(1e6, 100, 1e6)).toBe(1);
    expect(driftShare(1e9, 100, 1e6)).toBe(1);
  });
});

describe('focusAngle', () => {
  it('keeps the layout angle on a curved rim and reaches 0 once tips are apart', () => {
    expect(focusAngle(0.5, 0.001, 1)).toBeCloseTo(0.5, 12);
    expect(focusAngle(0.5, TURN_SPACING[1], 1)).toBe(0);
    expect(focusAngle(0.5, 48, 1)).toBe(0);
    // Auto-orient off: never turns.
    expect(focusAngle(0.5, 48, 0)).toBe(0.5);
  });
});

describe('rig', () => {
  it('drifts the anchor left as tips resolve, smoothly', () => {
    const r = rig();
    const l = layoutFor(2000, 1030);
    expect(r.anchor().x).toBeCloseTo(l.anchor.x, 9);
    r.set({ theta: 1.3, scale: r.maxScale() });
    expect(r.anchor().x).toBeCloseTo(l.deepX, 9);
    expect(l.deepX / 2000).toBeLessThanOrEqual(0.33);
    // Spread over the whole zoom: a wheel notch (×1.16) moves it ~15 px at most,
    // and it has already moved a little by mid zoom.
    let prev = r.anchorAt(r.minScale()).x;
    for (let s = r.minScale(); s < r.maxScale(); s *= 1.16) {
      const x = r.anchorAt(s).x;
      expect(Math.abs(x - prev)).toBeLessThan(17);
      prev = x;
    }
    const mid = r.anchorAt(Math.sqrt(r.minScale() * 1.5e6)).x;
    expect(mid).toBeLessThan(l.anchor.x - 100);
    expect(mid).toBeGreaterThan(l.deepX + 100);
  });

  it('puts the rim point at theta on the anchor, at every zoom', () => {
    const r = rig();
    for (const s of [r.minScale(), r.minScale() * 37, 1e6, r.maxScale()]) {
      r.set({ theta: 1.3, scale: s });
      const a = r.anchor();
      const p = rimAt(r, 1.3);
      expect(p.x).toBeCloseTo(a.x, 5);
      expect(p.y).toBeCloseTo(a.y, 5);
    }
  });

  it('composes the minimum zoom as in the reference: centre low left, rim up to the header', () => {
    const r = rig();
    const o = r.centre();
    expect(o.x / 2000).toBeGreaterThan(0.2);
    expect(o.x / 2000).toBeLessThan(0.33);
    expect(o.y / 1030).toBeGreaterThan(0.72);
    expect(o.y / 1030).toBeLessThan(0.86);
    // The wheel's centre is where the world origin lands.
    const w = r.camera.worldToScreen(0, 0);
    expect(w.x).toBeCloseTo(o.x, 6);
    expect(w.y).toBeCloseTo(o.y, 6);
    expect(o.y - r.scale).toBeCloseTo(64, 6);
  });

  it('zooms about the anchor: what is there stays put', () => {
    const r = rig();
    r.zoomBy(50);
    const a = r.anchor();
    // A point a little inside the rim at the anchor's angle stays on the
    // line from the anchor to the wheel's centre.
    const near = r.camera.polarToScreen(1.3, 1 - 10 / r.scale);
    expect(Math.hypot(near.x - a.x, near.y - a.y)).toBeCloseTo(10, 6);
  });

  it('turns the rim vertical at deep zoom, so tips point right', () => {
    const r = rig();
    r.set({ theta: 1.3, scale: r.maxScale() });
    const a = r.anchor();
    const out = r.camera.polarToScreen(1.3, 1 + 100 / r.scale);
    expect(out.x - a.x).toBeCloseTo(100, 4);
    expect(out.y - a.y).toBeCloseTo(0, 4);
  });

  it('clamps the zoom between the layout wheel and 48 px tips', () => {
    const r = rig(1440, 900, 2);
    r.set({ theta: 0, scale: 1 });
    expect(r.scale).toBe(r.minScale());
    expect(r.scale / 2).toBeCloseTo(layoutFor(1440, 900).radius, 9);
    r.zoomBy(1e30);
    expect((r.scale * TAU) / N / 2).toBeCloseTo(48, 9);
  });

  it('rotates by the angle swept about the wheel centre', () => {
    const r = rig();
    const o = r.centre();
    const p0 = { x: o.x + 300, y: o.y };
    const p1 = { x: o.x, y: o.y - 300 }; // a quarter turn counter-clockwise
    expect(r.sweep(p0, p1)).toBeCloseTo(Math.PI / 2, 12);
    const before = r.camera.polarToScreen(2, 0.5);
    r.rotateBy(r.sweep(p0, p1));
    expect(r.theta).toBeCloseTo(wrapAngle(1.3 - Math.PI / 2), 12);
    const after = r.camera.polarToScreen(2, 0.5);
    // The world turned a quarter counter-clockwise about the centre.
    const ang = (p: { x: number; y: number }): number => Math.atan2(o.y - p.y, p.x - o.x);
    expect(wrapAngle(ang(after) - ang(before))).toBeCloseTo(Math.PI / 2, 9);
  });

  it('drags the rim along with the pointer at deep zoom', () => {
    const r = rig();
    r.set({ theta: 1.3, scale: r.maxScale() });
    const a = r.anchor();
    // The rim is vertical at the anchor: drag 48 px down, one tip slot.
    r.rotateBy(r.sweep(a, { x: a.x, y: a.y + 48 }));
    const p = rimAt(r, 1.3);
    expect(p.y - a.y).toBeCloseTo(48, 4);
    expect(p.x - a.x).toBeCloseTo(0, 3) // the rim curves by 48²/2R;
  });

  it('keeps the camera exact at max zoom (sub-pixel)', () => {
    const r = rig();
    r.set({ theta: 4.0000001234, scale: r.maxScale() });
    const p = rimAt(r, 4.0000001234);
    const a = r.anchor();
    expect(Math.hypot(p.x - a.x, p.y - a.y)).toBeLessThan(1e-3);
  });
});
