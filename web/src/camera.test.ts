import { describe, expect, it } from 'vitest';
import { TWO_32, fromRad, wrapRad } from './angle';
import { Camera } from './camera';

function deepCamera(): Camera {
  const cam = new Camera(2_385_875);
  cam.setViewport(1440, 900, 1);
  cam.scale = cam.maxScale();
  cam.angle = 2.6;
  cam.r = 0.99997;
  cam.rot = 0.4;
  return cam;
}

describe('camera', () => {
  it('fits the wheel and clamps the zoom range', () => {
    const cam = new Camera(2_385_875);
    cam.setViewport(1440, 900, 1);
    cam.fit();
    const rim = cam.polarToScreen(Math.PI / 2, 1);
    expect(rim.x).toBeCloseTo(720, 9);
    // The rim leaves room outside it for group labels (FIT_MARGIN 0.86).
    expect(450 - rim.y).toBeGreaterThan(370);
    expect(450 - rim.y).toBeLessThan(420);
    cam.scale = cam.clampScale(1e12);
    expect(cam.tipSpacingPx()).toBeCloseTo(48, 9);
  });

  it('round-trips screen → world → screen at max zoom', () => {
    const cam = deepCamera();
    for (const [x, y] of [
      [0, 0],
      [720, 450],
      [1439.5, 13.25],
    ] as const) {
      const w = cam.screenToWorld(x, y);
      const s = cam.worldToScreen(w.x, w.y);
      expect(s.x).toBeCloseTo(x, 4);
      expect(s.y).toBeCloseTo(y, 4);
      const p = cam.screenToPolar(x, y);
      const q = cam.polarToScreen(p.theta, p.r);
      expect(q.x).toBeCloseTo(x, 4);
      expect(q.y).toBeCloseTo(y, 4);
    }
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const cam = deepCamera();
    cam.scale /= 1000;
    const before = cam.screenToWorld(300, 200);
    cam.zoomAt(300, 200, 3.7);
    const after = cam.worldToScreen(before.x, before.y);
    expect(after.x).toBeCloseTo(300, 6);
    expect(after.y).toBeCloseTo(200, 6);
  });

  it('pans the picture by exactly the dragged pixels', () => {
    const cam = deepCamera();
    const w = cam.screenToWorld(100, 100);
    cam.panBy(37, -23);
    const s = cam.worldToScreen(w.x, w.y);
    expect(s.x).toBeCloseTo(137, 5);
    expect(s.y).toBeCloseTo(77, 5);
  });

  it('splits uniforms into an exact u32 angle and hi/lo radius', () => {
    const cam = deepCamera();
    const u = cam.uniforms();
    expect(Number.isInteger(u.camA)).toBe(true);
    expect(u.camA).toBeGreaterThanOrEqual(0);
    expect(u.camA).toBeLessThan(TWO_32);
    expect(u.camA + u.camAFrac).toBeCloseTo(fromRad(cam.angle), 6);
    expect(Math.fround(u.camRHi)).toBe(u.camRHi);
    expect(u.camRHi + u.camRLo).toBe(cam.r);
    expect(Math.abs(u.camRLo)).toBeLessThan(1e-7);
    expect(Math.atan2(u.rotSin, u.rotCos)).toBeCloseTo(wrapRad(cam.rot + cam.angle), 12);
  });
});
