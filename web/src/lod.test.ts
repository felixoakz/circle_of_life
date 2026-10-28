import { describe, expect, it } from 'vitest';
import { TWO_32, fromRad, sectorOf } from './angle';
import { Camera } from './camera';
import {
  MAX_SECTORS_PER_LEVEL,
  computeView,
  keyLevel,
  keySector,
  levelFade,
  radialWindow,
  tileKey,
  viewLevel,
  visibleRange,
} from './lod';

const N = 2_385_875;
const P = 512;

function camera(): Camera {
  const cam = new Camera(N);
  cam.setViewport(1440, 900, 1);
  cam.fit();
  return cam;
}

describe('lod', () => {
  it('computes λ and clamps V', () => {
    const cam = camera();
    // λ = log2(2π·scale / (P · 0.5))
    expect(cam.lambda(P)).toBeCloseTo(Math.log2((2 * Math.PI * cam.scale) / 256), 12);
    expect(viewLevel(3.99, 13)).toBe(3);
    expect(viewLevel(-2, 13)).toBe(0);
    expect(viewLevel(18.7, 13)).toBe(13);
  });

  it('fades levels in over 0.6 of λ', () => {
    expect(levelFade(0, -5)).toBe(1);
    expect(levelFade(4, 3.9)).toBe(0);
    expect(levelFade(4, 4.3)).toBeCloseTo(0.5, 12);
    expect(levelFade(4, 4.6)).toBe(1);
  });

  it('packs tile keys', () => {
    const k = tileKey(13, 8191);
    expect(keyLevel(k)).toBe(13);
    expect(keySector(k)).toBe(8191);
  });

  it('sees the full circle when the origin is on screen', () => {
    const cam = camera();
    expect(visibleRange(cam)?.span).toBe(TWO_32);
    const v = computeView(cam, P, 13);
    // Budget rule: full circle → levels ≤ 6, at most 127 tiles.
    expect(v.fetchLevel).toBeLessThanOrEqual(6);
    expect(v.keys.length).toBeLessThanOrEqual(127);
    // Lowest level first.
    const levels = v.keys.map(keyLevel);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
  });

  it('caps every level at the sector budget near the origin', () => {
    // Zoomed in just beside the origin: a wide angular range at a deep level.
    const cam = camera();
    cam.scale = cam.fitScale() * 300;
    cam.r = 0.02;
    const v = computeView(cam, P, 13);
    expect(v.fetchLevel).toBeGreaterThan(6);
    expect(v.fetchLevel).toBeLessThan(v.level);
    for (let L = 0; L <= v.fetchLevel; L++) {
      expect(v.keys.filter((k) => keyLevel(k) === L).length).toBeLessThanOrEqual(MAX_SECTORS_PER_LEVEL);
    }
  });

  it('wants a few sectors around a deep view, nearest first', () => {
    const cam = camera();
    cam.scale = cam.maxScale();
    cam.angle = 2.6;
    cam.r = 0.9999;
    const range = visibleRange(cam);
    expect(range).not.toBeNull();
    // About 1440 px of rim at 48 px per tip.
    expect(((range?.span ?? 0) / TWO_32) * N).toBeGreaterThan(25);
    expect(((range?.span ?? 0) / TWO_32) * N).toBeLessThan(60);
    const v = computeView(cam, P, 13);
    expect(v.level).toBe(13);
    const centre = fromRad(cam.angle);
    expect(v.keys).toContain(tileKey(13, sectorOf(centre, 13)));
    expect(v.keys.length).toBeLessThan(40);
    // The radial window is a thin band around the rim.
    const [r0, r1] = radialWindow(cam);
    expect(r0).toBeGreaterThan(0.9998);
    expect(r1).toBeLessThan(1.0001);
  });

  it('returns no range when the screen is outside the rim', () => {
    const cam = camera();
    cam.scale = cam.fitScale() * 20;
    cam.r = 1.15;
    expect(visibleRange(cam)).toBeNull();
    expect(computeView(cam, P, 13).keys).toEqual([tileKey(0, 0)]);
  });
});
