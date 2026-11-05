import { describe, expect, it } from 'vitest';
import { TAU } from './angle';
import { Camera } from './camera';
import { layoutFor } from './layout';
import { Rig, clampFree, driftShare, focusAngle, freeAbout, freePan, wrapAngle } from './rig';
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

describe('free view', () => {
  const W = 2000;
  const H = 1030;
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

  it('enters where the locked view is, and set() leaves it', () => {
    const r = rig();
    r.set({ theta: 1.3, scale: r.minScale() * 300 });
    const before = r.camera.polarToScreen(1.31, 0.6);
    r.enterFree();
    expect(r.isFree()).toBe(true);
    expect(dist(r.camera.polarToScreen(1.31, 0.6), before)).toBeLessThan(1e-6);
    r.set({ theta: 1.3, scale: r.minScale() });
    expect(r.isFree()).toBe(false);
  });

  it('cameraFor is the camera the locked view writes', () => {
    const r = rig();
    for (const s of [r.minScale(), 1e5, r.maxScale()]) {
      r.set({ theta: 0.7, scale: s });
      const f = r.cameraFor(r.pose());
      const c = r.camera.centre();
      expect(f.x).toBeCloseTo(c.x, 14);
      expect(f.y).toBeCloseTo(c.y, 14);
      expect(f.rot).toBeCloseTo(r.camera.rot, 14);
    }
  });

  it('zooms about the cursor: the point under it stays put', () => {
    const r = rig();
    r.enterFree();
    const p = { x: 400, y: 700 };
    const w = r.camera.screenToWorld(p.x, p.y);
    r.zoomAt(40, p);
    expect(r.scale).toBeCloseTo(r.minScale() * 40, 6);
    expect(dist(r.camera.worldToScreen(w.x, w.y), p)).toBeLessThan(1e-6);
  });

  it('dives to maximum zoom mid-wheel without losing a pixel', () => {
    const r = rig();
    r.enterFree();
    // A point halfway in, among the inner branches; zoom about it in wheel notches.
    const target = { x: 0.5 * Math.cos(2.2), y: 0.5 * Math.sin(2.2) };
    let p = r.camera.worldToScreen(target.x, target.y);
    r.panBy(W / 2 - p.x, H / 2 - p.y);
    p = r.camera.worldToScreen(target.x, target.y);
    for (let i = 0; i < 400 && r.scale < r.maxScale(); i++) r.zoomAt(1.16, p);
    expect(dist(r.camera.worldToScreen(target.x, target.y), p)).toBeLessThan(1e-3);
    expect(r.scale).toBe(r.maxScale());
    // Pan a little and turn about a point, at max zoom: the picture moves rigidly.
    const q = r.camera.screenToWorld(900, 500);
    r.panBy(37, 23);
    expect(dist(r.camera.worldToScreen(q.x, q.y), { x: 937, y: 523 })).toBeLessThan(1e-3);
    r.rotateAt(0.3, { x: 937, y: 523 });
    expect(dist(r.camera.worldToScreen(q.x, q.y), { x: 937, y: 523 })).toBeLessThan(1e-3);
    // Still mid-wheel.
    const c = r.camera.screenToPolar(W / 2, H / 2);
    expect(c.r).toBeGreaterThan(0.45);
    expect(c.r).toBeLessThan(0.55);
  });

  it('pans with the pointer and turns about a point', () => {
    const f = { x: 0.3, y: 0.1, scale: 1000, rot: 0.4 };
    const cam = new Camera(N);
    cam.setViewport(W, H, 1);
    const put = (g: typeof f): void => {
      cam.scale = g.scale;
      cam.rot = g.rot;
      cam.setCentre(g.x, g.y);
    };
    put(f);
    const w = cam.screenToWorld(500, 300);
    put(freePan(f, 20, -10));
    expect(dist(cam.worldToScreen(w.x, w.y), { x: 520, y: 290 })).toBeLessThan(1e-9);
    const turned = freeAbout(f, f.scale, 0.5, { x: 500, y: 300 }, W, H);
    put(turned);
    expect(turned.rot).toBeCloseTo(0.9, 12);
    expect(dist(cam.worldToScreen(w.x, w.y), { x: 500, y: 300 })).toBeLessThan(1e-9);
  });

  it('keeps the wheel within reach of the screen', () => {
    const far = clampFree({ x: 30, y: 40, scale: 100, rot: 0 }, 500);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1 + 500 / 100, 12);
    const near = { x: 0.2, y: 0.1, scale: 100, rot: 0 };
    expect(clampFree(near, 500)).toBe(near);
    const r = rig();
    r.enterFree();
    r.panBy(-1e6, 0);
    const c = r.camera.centre();
    expect(Math.hypot(c.x, c.y)).toBeLessThanOrEqual(1 + (0.5 * W) / r.scale + 1e-12);
  });

  it('turns about the screen centre with rotateBy (the ambient turn never runs here, but stays sane)', () => {
    const r = rig();
    r.enterFree();
    const c = r.camera.screenToWorld(W / 2, H / 2);
    r.rotateBy(1);
    expect(dist(r.camera.worldToScreen(c.x, c.y), { x: W / 2, y: H / 2 })).toBeLessThan(1e-6);
  });
});
