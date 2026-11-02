import { describe, expect, it } from 'vitest';
import { TAU } from './angle';
import { FLAG_HOME } from './tiles/decode';
import type { NodeInfo } from './types';
import { ringPoint, suitScale } from './selection';

const N = 2_385_875;
const SPAN = 900;

function node(fields: Partial<NodeInfo>): NodeInfo {
  return { childCount: 2, flags: 0, angle: 0, arcLo: 0, arcHi: 0, r: 0.5, ...fields } as NodeInfo;
}

describe('suitScale', () => {
  /** CSS px between tips at a scale (DPR 2 here). */
  const spacing = (s: number): number => (s * TAU) / N / 2;

  it('frames a species with its neighbours: SUIT_MIN_TIPS tips across', () => {
    // 0.6 · 900 CSS px over 24 tips: 22.5 px between tips.
    expect(spacing(suitScale(node({ childCount: 0, leafCount: 1, r: 1 }), N, SPAN * 2, 2))).toBeCloseTo(22.5, 9);
  });

  it("fits a big clade's tips (not its connector arc) to SUIT_FILL of the span", () => {
    const s = suitScale(node({ leafCount: 600, arcLo: 0, arcHi: 10, r: 0.5 }), N, SPAN * 2, 2);
    expect(spacing(s)).toBeCloseTo((0.6 * SPAN) / 600, 9);
  });

  it('zooms a small clade on until its names show', () => {
    // 150 tips would be 3.6 px apart: names need 11.
    expect(spacing(suitScale(node({ leafCount: 150 }), N, SPAN * 2, 2))).toBe(14);
  });

  it('wants less than the whole wheel for the root (the rig clamps it to the minimum)', () => {
    expect(suitScale(node({ leafCount: N, r: 0 }), N, SPAN, 1)).toBeLessThan(100);
  });
});

describe('ringPoint', () => {
  it('rings tips and Homo sapiens at the rim, clades at their node', () => {
    expect(ringPoint(node({ childCount: 0, r: 0.97, angle: 5 }))).toEqual({ angle: 5, r: 1 });
    expect(ringPoint(node({ childCount: 3, flags: FLAG_HOME, r: 0.97 })).r).toBe(1);
    expect(ringPoint(node({ r: 0.6 })).r).toBe(0.6);
  });
});
