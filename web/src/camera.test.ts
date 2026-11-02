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
  it('sets the maximum zoom at 48 CSS px between tips', () => {
    const cam = new Camera(2_385_875);
    cam.setViewport(1440, 900, 2);
    cam.scale = cam.maxScale();
    expect(cam.tipSpacingPx() / cam.dpr).toBeCloseTo(48, 9);
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

  it('puts the centre point in the middle of the screen', () => {
    const cam = deepCamera();
    const c = cam.centre();
    const s = cam.worldToScreen(c.x, c.y);
    expect(s.x).toBeCloseTo(720, 9);
    expect(s.y).toBeCloseTo(450, 9);
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
