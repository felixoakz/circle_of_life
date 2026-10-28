import { describe, expect, it } from 'vitest';
import { backingStoreSize, treeDpr } from './context';

describe('backingStoreSize', () => {
  it('scales the CSS size by the device pixel ratio', () => {
    expect(backingStoreSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it('rounds fractional ratios to whole device pixels', () => {
    expect(backingStoreSize(1001, 333, 1.25)).toEqual({ width: 1251, height: 416 });
  });

  it('never returns a zero-sized buffer', () => {
    expect(backingStoreSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe('treeDpr', () => {
  const cap = 8_300_000;
  it('keeps the screen DPR while the canvas fits the cap', () => {
    expect(treeDpr(1440, 900, 2, cap)).toBe(2);
  });

  it('lowers the DPR of a 5K canvas to about the cap', () => {
    const d = treeDpr(2560, 1440, 2, cap);
    expect(d).toBeLessThan(2);
    expect(2560 * d * 1440 * d).toBeCloseTo(cap, -3);
  });

  it('never goes below 1 for a DPR ≥ 1 screen', () => {
    expect(treeDpr(7680, 4320, 1, cap)).toBe(1);
  });
});
