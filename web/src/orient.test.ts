import { describe, expect, it } from 'vitest';
import { RAD_PER_UNIT, TWO_32, wrapRad } from './angle';
import { Camera } from './camera';
import { AutoOrient, compositionRotation, horizontalRotation } from './orient';
import { ANIMALS_SCREEN_DEG, ORIENT_MS } from './style';

const DEG = Math.PI / 180;

function deepCamera(spacingPx: number, angle: number): Camera {
  const cam = new Camera(2_000_000);
  cam.setViewport(1440, 900, 1);
  cam.angle = angle;
  cam.r = 0.9999;
  cam.scale = cam.clampScale((spacingPx * cam.tipCount) / (2 * Math.PI));
  return cam;
}

describe('compositionRotation', () => {
  it('puts the largest Animals run midpoint at the chosen screen angle', () => {
    const runs = [
      { group: 4, angleLo: 0, angleHi: 0.05 * TWO_32 },
      { group: 0, angleLo: 0.1 * TWO_32, angleHi: 0.12 * TWO_32 }, // small Animals run
      { group: 0, angleLo: 0.375 * TWO_32, angleHi: TWO_32 - 1 },
    ];
    const rot = compositionRotation(runs);
    const mid = ((0.375 * TWO_32 + TWO_32 - 1) / 2) * RAD_PER_UNIT;
    expect(wrapRad(mid + rot - ANIMALS_SCREEN_DEG * DEG)).toBeCloseTo(0, 9);
  });
});

describe('horizontalRotation', () => {
  it('turns the outward direction to the nearer of ±x', () => {
    for (const [theta, ref] of [
      [0.3, 0.1],
      [2.0, -1.0],
      [5.5, 3.0],
    ] as const) {
      const rot = horizontalRotation(theta, ref);
      expect(Math.abs(Math.sin(theta + rot))).toBeLessThan(1e-12);
      expect(Math.abs(rot - ref)).toBeLessThanOrEqual(Math.PI / 2 + 1e-12);
    }
  });
});

describe('AutoOrient', () => {
  it('engages above 4 px, eases to horizontal, then returns when zoomed out', () => {
    const cam = deepCamera(8, 1.0);
    cam.rot = 0.4;
    const orient = new AutoOrient(cam, 0);
    expect(orient.step(0)).toBe(true);
    orient.step(ORIENT_MS / 2);
    expect(Math.abs(Math.sin(cam.angle + cam.rot))).toBeGreaterThan(1e-3); // still turning
    expect(orient.step(ORIENT_MS)).toBe(false);
    expect(Math.abs(Math.sin(cam.angle + cam.rot))).toBeLessThan(1e-9);

    cam.scale = cam.fitScale();
    orient.step(1000);
    orient.step(1000 + ORIENT_MS);
    expect(cam.rot).toBeCloseTo(0.4, 9);
  });

  it('cuts instead of animating under reduced motion, and R turns it off', () => {
    const cam = deepCamera(8, 2.0);
    const orient = new AutoOrient(cam, 0);
    orient.reducedMotion = true;
    expect(orient.step(0)).toBe(false);
    expect(Math.abs(Math.sin(cam.angle + cam.rot))).toBeLessThan(1e-9);
    orient.toggle(0);
    orient.step(0);
    expect(cam.rot).toBeCloseTo(0, 9);
  });
});
