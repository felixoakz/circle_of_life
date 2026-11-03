import { describe, expect, it } from 'vitest';
import { TAU } from './angle';
import { FLAG_HOME } from './tiles/decode';
import type { NodeInfo } from './types';
import { announcement, ringPoint, suitScale } from './selection';

const N = 2_385_875;
const SPAN = 900;

function node(fields: Partial<NodeInfo>): NodeInfo {
  return { childCount: 2, flags: 0, angle: 0, arcLo: 0, arcHi: 0, r: 0.5, ...fields } as NodeInfo;
}

describe('suitScale', () => {
  /** CSS px between tips at a scale (DPR 2 here). */
  const spacing = (s: number): number => (s * TAU) / N / 2;

  it('frames a species with its neighbours: SUIT_MIN_TIPS tips across', () => {
    // 0.9 · 900 CSS px over 24 tips: 33.75 px between tips.
    expect(spacing(suitScale(node({ childCount: 0, leafCount: 1, r: 1 }), N, SPAN * 2, 2))).toBeCloseTo(33.75, 9);
  });

  it("fits a big clade's tips (not its connector arc) to SUIT_FILL of the span", () => {
    const s = suitScale(node({ leafCount: 600, arcLo: 0, arcHi: 10, r: 0.5 }), N, SPAN * 2, 2);
    expect(spacing(s)).toBeCloseTo((0.9 * SPAN) / 600, 9);
  });

  it('zooms a small clade on until its names show, when all its tips still fit', () => {
    // 60 tips would be 13.5 px apart: names need 14, and 60 · 14 px fit the 900 px span.
    expect(spacing(suitScale(node({ leafCount: 60 }), N, SPAN * 2, 2))).toBe(14);
  });

  it('shows a clade too big for named rows whole instead (Felidae: 91 tips)', () => {
    expect(spacing(suitScale(node({ leafCount: 91 }), N, SPAN * 2, 2))).toBeCloseTo((0.9 * SPAN) / 91, 9);
  });

  it('wants less than the whole wheel for the root (the rig clamps it to the minimum)', () => {
    expect(suitScale(node({ leafCount: N, r: 0 }), N, SPAN, 1)).toBeLessThan(200);
  });
});

describe('ringPoint', () => {
  it('rings tips, Homo sapiens and species with subspecies at the rim, clades at their node', () => {
    expect(ringPoint(node({ childCount: 0, r: 0.97, angle: 5 }))).toEqual({ angle: 5, r: 1 });
    expect(ringPoint(node({ childCount: 3, flags: FLAG_HOME, r: 0.97 })).r).toBe(1);
    expect(ringPoint(node({ childCount: 7, rank: 'species', r: 0.98 })).r).toBe(1);
    expect(ringPoint(node({ r: 0.6 })).r).toBe(0.6);
  });
});

describe('announcement', () => {
  it('says the name, rank and size in words', () => {
    expect(announcement(node({ name: 'Homo sapiens', rank: 'species', childCount: 2, leafCount: 2, flags: FLAG_HOME }))).toBe(
      'Homo sapiens, species, 2 subspecies. You are here.',
    );
    expect(announcement(node({ name: 'Felidae', rank: 'family', childCount: 14, leafCount: 91 }))).toBe('Felidae, family, 91 species.');
    expect(announcement(node({ name: 'Panthera onca', rank: 'species', childCount: 0, leafCount: 1 }))).toBe('Panthera onca, species.');
  });
});
