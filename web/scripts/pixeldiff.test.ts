import { describe, expect, it } from 'vitest';
import { diffImages } from './pixeldiff';

/** A w×h opaque image of one colour. */
function solid(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([...rgb, 255], i * 4);
  return out;
}

const pixel = (img: Uint8ClampedArray, w: number, x: number, y: number): number[] => [
  ...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4),
];

describe('diffImages', () => {
  it('finds nothing between identical images', () => {
    const a = solid(4, 3, [10, 20, 30]);
    const r = diffImages(a, a.slice(), 4, 3, 16);
    expect(r).toMatchObject({ over: 0, overPct: 0, meanAbs: 0, maxAbs: 0 });
    expect(r.heatmap.length).toBe(4 * 3 * 4);
    expect(pixel(r.heatmap, 4, 2, 1)).toEqual([0, 0, 0, 255]);
  });

  it('counts a pixel over tolerance by its largest channel difference', () => {
    const a = solid(10, 10, [100, 100, 100]);
    const b = a.slice();
    b.set([100, 117, 100, 255], (2 * 10 + 3) * 4); // 17 > 16: over
    b.set([116, 100, 84, 255], (5 * 10 + 5) * 4); // 16 on two channels: within
    const r = diffImages(a, b, 10, 10, 16);
    expect(r.over).toBe(1);
    expect(r.overPct).toBeCloseTo(1, 10); // 1 of 100 pixels, as a percentage
    expect(r.maxAbs).toBe(17);
    expect(r.meanAbs).toBeCloseTo((17 + 16 + 16) / 400, 10);
    expect(pixel(r.heatmap, 10, 3, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(r.heatmap, 10, 5, 5)).toEqual([64, 64, 64, 255]);
    expect(pixel(r.heatmap, 10, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it('includes alpha in the differences', () => {
    const a = solid(2, 1, [0, 0, 0]);
    const b = a.slice();
    b[3] = 0;
    const r = diffImages(a, b, 2, 1, 16);
    expect(r.over).toBe(1);
    expect(r.maxAbs).toBe(255);
  });

  it('accepts Uint8Array input too', () => {
    const a = new Uint8Array(solid(2, 2, [1, 2, 3]));
    const r = diffImages(a, a.slice(), 2, 2, 0);
    expect(r.over).toBe(0);
  });

  it('rejects images of the wrong size', () => {
    expect(() => diffImages(solid(2, 2, [0, 0, 0]), solid(3, 2, [0, 0, 0]), 2, 2, 16)).toThrow(/size/);
  });
});
