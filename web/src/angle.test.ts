import { describe, expect, it } from 'vitest';
import {
  FULL_CIRCLE,
  cladeRim,
  tipAngle,
  TWO_32,
  fromRad,
  sectorOf,
  sectorWidth,
  sectorsIn,
  toRad,
  widen,
  wrap,
  wrapDiff,
  wrapRad,
} from './angle';

describe('angle', () => {
  it('converts between u32 units and radians', () => {
    expect(toRad(TWO_32 / 4)).toBeCloseTo(Math.PI / 2, 15);
    expect(fromRad(Math.PI)).toBe(TWO_32 / 2);
    expect(fromRad(-Math.PI / 2)).toBe((3 * TWO_32) / 4);
    expect(fromRad(2 * Math.PI)).toBe(0);
    expect(fromRad(toRad(1780855860.25))).toBeCloseTo(1780855860.25, 4);
  });

  it('wraps differences through zero', () => {
    expect(wrapDiff(5, TWO_32 - 5)).toBe(10);
    expect(wrapDiff(TWO_32 - 5, 5)).toBe(-10);
    expect(wrapDiff(0, TWO_32 / 2)).toBe(-TWO_32 / 2);
    expect(wrapDiff(100.5, 100)).toBe(0.5);
    expect(wrap(-1)).toBe(TWO_32 - 1);
    expect(wrapRad(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('finds sectors like the Rust side (level 0 is special)', () => {
    expect(sectorOf(0xffffffff, 0)).toBe(0);
    expect(sectorOf(0xffffffff, 1)).toBe(1);
    expect(sectorOf(0x80000000, 13)).toBe(4096);
    expect(sectorWidth(13)).toBe(2 ** 19);
  });

  it('lists sectors of a range, wrapping through 0', () => {
    expect(sectorsIn({ lo: 10, span: 20 }, 3)).toEqual([0]);
    expect(sectorsIn({ lo: TWO_32 - 10, span: 20 }, 3)).toEqual([7, 0]);
    expect(sectorsIn({ lo: sectorWidth(2) - 1, span: 2 }, 2)).toEqual([0, 1]);
    expect(sectorsIn(FULL_CIRCLE, 2)).toEqual([0, 1, 2, 3]);
    // Nearly the full circle, ending in the starting sector.
    expect(sectorsIn({ lo: 5, span: TWO_32 - 1 }, 2)).toEqual([0, 1, 2, 3]);
  });

  it('widens a range and saturates at the full circle', () => {
    expect(widen({ lo: 5, span: 10 }, 10)).toEqual({ lo: TWO_32 - 5, span: 30 });
    expect(widen({ lo: 0, span: TWO_32 - 4 }, 4)).toBe(FULL_CIRCLE);
  });
});

describe('clade extent from first_tip (review P1-1)', () => {
  // Pan (ott417957) in otl16.1: paniscus, then troglodytes with five
  // subspecies. Its arc ends at troglodytes' midpoint, the middle subspecies.
  const N = 2_385_875;
  const pan = { arcLo: 1780824357, arcHi: 1780829758, leafCount: 6 };
  const slot = TWO_32 / N;
  // Its first child, paniscus, is a tip: arcLo is the first tip's angle.
  const firstTip = Math.round(pan.arcLo / slot - 0.5);

  it('reproduces the ingest tip angles', () => {
    expect(tipAngle(firstTip, N)).toBe(pan.arcLo);
    expect(tipAngle(firstTip + 3, N)).toBe(pan.arcHi);
  });

  it('covers all six tips, two past the arc', () => {
    const [lo, span] = cladeRim(firstTip, pan.leafCount, N);
    expect(lo).toBeLessThan(pan.arcLo);
    const end = lo + span;
    expect(end).toBeGreaterThan(tipAngle(firstTip + 5, N));
    expect(end - pan.arcHi).toBeCloseTo(2.5 * slot, -1);
  });
});
