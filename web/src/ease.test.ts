import { describe, expect, it } from 'vitest';
import { cubicBezier, easeInOut, smoothstep } from './ease';

describe('ease', () => {
  it('smoothstep clamps and is symmetric', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(2, 4, 3)).toBeCloseTo(0.5);
  });

  it('easeInOut runs 0 → 1 through ½', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
  });

  it('cubicBezier matches CSS: linear, endpoints, monotone', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.37, 0.8]) expect(linear(t)).toBeCloseTo(t, 6);
    const intro = cubicBezier(0.2, 0, 0, 1);
    expect(intro(0)).toBe(0);
    expect(intro(1)).toBe(1);
    // A strong ease-out: well past half-way at half time.
    expect(intro(0.5)).toBeGreaterThan(0.8);
    let prev = 0;
    for (let i = 1; i <= 50; i++) {
      const y = intro(i / 50);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});
