import { describe, expect, it } from 'vitest';
import { layoutFor } from '../layout';
import { ZOOM_FLOOR, percentFraction, scaleAt, stripBox, zoomFraction, zoomPercent } from './zoomstrip';

const MIN = 752;
const MAX = 1.82e7;

describe('zoom scale', () => {
  it('reads ZOOM_FLOOR % at minimum zoom and 100% at maximum', () => {
    expect(zoomPercent(zoomFraction(MIN, MIN, MAX))).toBe(ZOOM_FLOOR);
    expect(zoomPercent(zoomFraction(MAX, MIN, MAX))).toBe(100);
    expect(ZOOM_FLOOR).toBeGreaterThan(0);
  });

  it('is logarithmic: the geometric middle is half way', () => {
    expect(zoomFraction(Math.sqrt(MIN * MAX), MIN, MAX)).toBeCloseTo(0.5, 12);
    // Equal zoom factors are equal steps.
    const a = zoomFraction(MIN * 4, MIN, MAX) - zoomFraction(MIN * 2, MIN, MAX);
    const b = zoomFraction(MIN * 1024, MIN, MAX) - zoomFraction(MIN * 512, MIN, MAX);
    expect(a).toBeCloseTo(b, 12);
  });

  it('round-trips scale ↔ fraction ↔ percent, clamped', () => {
    for (const s of [MIN, 5000, 1e6, MAX]) expect(scaleAt(zoomFraction(s, MIN, MAX), MIN, MAX)).toBeCloseTo(s, 3);
    expect(percentFraction(zoomPercent(0.37))).toBeCloseTo(0.37, 12);
    expect(zoomFraction(MIN / 10, MIN, MAX)).toBe(0);
    expect(percentFraction(150)).toBe(1);
  });

  it('keeps the strip clear of the header, the card and the bottom HUD', () => {
    for (const [w, h] of [
      [2000, 1030],
      [1440, 900],
      [1280, 800],
      [390, 844],
    ] as const) {
      const l = layoutFor(w, h);
      const b = stripBox(l, h);
      expect(b.y0).toBeGreaterThanOrEqual(l.compact ? l.card.y1 : 56);
      // Scale, "−" and the reset button stay above the breadcrumb band.
      expect(b.y1 + (l.compact ? 76 : 60)).toBeLessThanOrEqual(h - (l.compact ? 64 : 96));
      expect(b.y1 - b.y0).toBeGreaterThanOrEqual(80);
      // The "+" step above it stays under the header (desktop) or the card (phone).
      expect(b.y0 - 26).toBeGreaterThanOrEqual(l.compact ? l.card.y1 : 44);
    }
  });

  it('spans two thirds of the height on desktop, centred where it fits', () => {
    for (const [w, h] of [
      [2000, 1030],
      [1440, 900],
      [1229, 900],
    ] as const) {
      const b = stripBox(layoutFor(w, h), h);
      expect(b.y1 - b.y0).toBeCloseTo((2 * h) / 3, 6);
      // Centred, or as near as the bottom HUD and the 40 px buttons under it allow.
      expect(Math.abs((b.y0 + b.y1) / 2 - h / 2)).toBeLessThanOrEqual(20);
    }
    // A short window: as much as fits between the header and the HUD.
    const b = stripBox(layoutFor(1280, 720), 720);
    expect(b.y1 - b.y0).toBeCloseTo(480, 6);
  });

  it('takes all the room under the card on a phone', () => {
    const l = layoutFor(390, 844);
    const b = stripBox(l, 844);
    expect(b.y0).toBe(l.card.y1 + 48);
    expect(b.y1).toBe(844 - 64 - 76);
  });
});
