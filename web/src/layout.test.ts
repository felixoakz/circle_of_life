import { describe, expect, it } from 'vitest';
import { isCompact, layoutFor, suitSpan, wheelCentre } from './layout';

describe('layoutFor', () => {
  it('matches the reference composition at 2000×1030', () => {
    const l = layoutFor(2000, 1030);
    expect(l.compact).toBe(false);
    // The card: x 62%–99%, y ~6%–40%.
    expect(l.card.x0 / 2000).toBeCloseTo(0.62, 2);
    expect(l.card.x1).toBe(1984);
    expect(l.card.y0).toBe(60);
    expect(l.card.y1 / 1030).toBeCloseTo(0.4, 2);
    // The anchor just below and left of the card's corner.
    expect(l.anchor.x).toBeLessThan(l.card.x0);
    expect(l.anchor.y).toBeGreaterThan(l.card.y1);
    const c = wheelCentre(l);
    expect(c.x / 2000).toBeGreaterThan(0.22);
    expect(c.x / 2000).toBeLessThan(0.3);
    expect(c.y / 1030).toBeGreaterThan(0.75);
    expect(c.y / 1030).toBeLessThan(0.84);
    // The rim's top sits under the header, its right edge near the card's left.
    expect(c.y - l.radius).toBeCloseTo(64, 9);
    expect((c.x + l.radius) / 2000).toBeGreaterThan(0.6);
    expect((c.x + l.radius) / 2000).toBeLessThan(0.66);
  });

  it('keeps the card wide enough on a small laptop', () => {
    const l = layoutFor(1024, 700);
    expect(l.card.x1 - l.card.x0).toBeGreaterThanOrEqual(340);
    expect(l.card.y1 - l.card.y0).toBeGreaterThanOrEqual(240);
  });

  it('puts the card on top and the wheel below on a phone', () => {
    expect(isCompact(390, 844)).toBe(true);
    expect(isCompact(820, 1180)).toBe(true);
    expect(isCompact(1440, 900)).toBe(false);
    const l = layoutFor(390, 844);
    expect(l.compact).toBe(true);
    expect(l.card.x0).toBe(12);
    expect(l.card.x1).toBe(378);
    expect(l.card.y1).toBeLessThan(844 * 0.4);
    // Anchor under the card; the rim's right edge inside the screen.
    expect(l.anchor.y).toBeGreaterThan(l.card.y1);
    expect(l.anchor.x).toBeGreaterThan(0);
    const c = wheelCentre(l);
    expect(c.x + l.radius).toBeLessThan(390);
    expect(c.y / 844).toBeCloseTo(0.86, 6);
  });
});

describe('card bounds', () => {
  it('lets a desktop card grow below its nominal box, never a phone card', () => {
    const d = layoutFor(1280, 720);
    expect(d.cardMax.y1).toBeGreaterThan(d.card.y1);
    expect(d.cardMax.y1).toBeLessThanOrEqual(720 - 152);
    const p = layoutFor(390, 844);
    expect(p.cardMax).toEqual(p.card);
  });
});

describe('suitSpan', () => {
  it('is twice the smaller room round the anchor', () => {
    const l = layoutFor(1440, 900);
    const above = l.anchor.y - 60;
    const below = 900 - 96 - l.anchor.y;
    expect(suitSpan(l, 900)).toBe(2 * Math.min(above, below));
  });

  it('stops under the card on a phone', () => {
    const l = layoutFor(390, 844);
    expect(suitSpan(l, 844)).toBe(2 * Math.min(l.anchor.y - l.card.y1 - 8, 844 - 96 - l.anchor.y));
  });
});
