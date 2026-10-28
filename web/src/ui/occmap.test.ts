import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, TILE, mapView, mercX, mercY } from './occmap';

describe('mercator', () => {
  it('maps the corners and the equator', () => {
    expect(mercX(-180)).toBe(0);
    expect(mercX(180)).toBe(1);
    expect(mercY(0)).toBeCloseTo(0.5, 12);
    expect(mercY(85.0511)).toBeCloseTo(0, 4);
    expect(mercY(-90)).toBeCloseTo(1, 4); // clamped
  });
});

describe('mapView', () => {
  it('shows the whole world at least as wide as the box', () => {
    const v = mapView(null, 346, 173);
    expect(v.z).toBe(0);
    expect(v.size).toBe(346); // the world exactly fills the width
    expect(v.tiles).toHaveLength(1);
    expect(v.tiles[0]).toMatchObject({ x: 0, y: 0, left: 0 });
  });

  it('zooms in on a small range and covers the box with tiles', () => {
    // The jaguar: Americas.
    const v = mapView([-123, -53, 19, 51], 346, 173);
    expect(v.z).toBeGreaterThanOrEqual(0);
    expect(v.size).toBeLessThanOrEqual(TILE * 2);
    // Every pixel of the box lies in some tile (no gaps at the edges).
    const corners: [number, number][] = [
      [0, 0],
      [345, 0],
      [0, 172],
      [345, 172],
      [173, 86],
    ];
    for (const [px, py] of corners) {
      const hit = v.tiles.some((t) => px >= t.left && px < t.left + t.size && py >= t.top && py < t.top + t.size);
      expect(hit, `${px},${py}`).toBe(true);
    }
  });

  it('never zooms past MAX_ZOOM for a single point', () => {
    const v = mapView([10, 10, 10, 10], 346, 173);
    expect(v.z).toBe(MAX_ZOOM);
  });

  it('wraps tile columns across the antimeridian', () => {
    const v = mapView([170, -20, 179, -10], 346, 173);
    const n = 2 ** v.z;
    for (const t of v.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(n);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(n);
    }
  });
});
