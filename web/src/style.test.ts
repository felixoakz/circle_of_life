import { describe, expect, it } from 'vitest';
import {
  BRANCH_ALPHA,
  BRANCH_ALPHA_DEEP,
  GLOW_DEEP,
  LINE_DEEP_ALPHA,
  LINE_DEEP_PX,
  PATH_LINE_RATIO,
  PATH_MAX_PX,
  PATH_WIDTH_PX,
  TIP_BAR_ALPHA,
  TIP_GREEK_ALPHA,
  TIP_GREEK_SPACING,
  TIP_LABEL_SPACING,
  TIP_TEXT_FADE,
  frameLook,
  pathWidthPx,
  tipColumnAlpha,
  tipFontPx,
  tipGreekAlpha,
  tipTextAlpha,
} from './style';

describe('frameLook', () => {
  it('glows most on the whole wheel and shows no tip bars there', () => {
    const l = frameLook({ lambda: 3.4, tipSpacing: 0.001 });
    expect(l.glow).toBe(1);
    expect(l.ring).toBe(1);
    expect(l.tipBar).toBe(0);
    expect(l.leader).toBe(0);
    expect(l.branchAlpha).toBe(BRANCH_ALPHA);
  });

  it('trades the rim ring for bright tip bars as tips resolve', () => {
    const l = frameLook({ lambda: 13.5, tipSpacing: 1.3 });
    expect(l.ring).toBe(0);
    expect(l.tipBar).toBe(TIP_BAR_ALPHA);
  });

  it('drops tip bars at deep zoom, so branches run evenly into their names', () => {
    const l = frameLook({ lambda: 18.8, tipSpacing: 48 });
    expect(l.glow).toBeCloseTo(GLOW_DEEP);
    expect(l.ring).toBe(0);
    expect(l.tipBar).toBe(0);
    expect(frameLook({ lambda: 15.8, tipSpacing: 6 }).tipBar).toBe(0);
    expect(l.leader).toBe(1);
    // Full width, full alpha: solid strokes, not a dim olive.
    expect(l.branchAlpha).toBe(LINE_DEEP_ALPHA);
    expect(frameLook({ lambda: 15.8, tipSpacing: 6 }).branchAlpha).toBe(BRANCH_ALPHA_DEEP);
  });

  it('thickens lines only once tips read as single lines', () => {
    expect(frameLook({ lambda: 3.4, tipSpacing: 0.001 }).lineWidth).toBe(0);
    expect(frameLook({ lambda: 15, tipSpacing: 8 }).lineWidth).toBe(0);
    const mid = frameLook({ lambda: 17, tipSpacing: 20 }).lineWidth;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(LINE_DEEP_PX);
    expect(frameLook({ lambda: 18.8, tipSpacing: 48 }).lineWidth).toBe(LINE_DEEP_PX);
  });

  it('reads as a solid stroke of about 3 px at max zoom', () => {
    expect(LINE_DEEP_PX).toBeGreaterThanOrEqual(2.5);
    expect(LINE_DEEP_PX).toBeLessThanOrEqual(3.5);
  });
});

describe('pathWidthPx', () => {
  it('keeps the plain path width while lines are hairlines', () => {
    expect(pathWidthPx(PATH_WIDTH_PX, 0)).toBe(PATH_WIDTH_PX);
  });

  it('stays heavier than thick lines, within PATH_MAX_PX', () => {
    expect(pathWidthPx(PATH_WIDTH_PX, 2)).toBe(Math.min(PATH_MAX_PX, PATH_LINE_RATIO * 2));
    expect(pathWidthPx(PATH_WIDTH_PX, LINE_DEEP_PX)).toBe(PATH_MAX_PX);
    expect(PATH_MAX_PX).toBeGreaterThan(1.5 * LINE_DEEP_PX);
  });
});

describe('tip names over zoom', () => {
  const spacings = Array.from({ length: 200 }, (_, i) => 0.5 + i * 0.25);

  it('keeps the font size continuous, shrinking with the rows below TIP_LABEL_SPACING', () => {
    expect(tipFontPx(TIP_LABEL_SPACING)).toBe(12);
    expect(tipFontPx(48)).toBe(22);
    expect(tipFontPx(5.5)).toBeCloseTo(6, 9);
    for (const s of spacings) {
      expect(tipFontPx(s + 0.25)).toBeGreaterThanOrEqual(tipFontPx(s));
      // A name's box (0.85 of the size) never reaches the next row.
      expect(0.85 * tipFontPx(s)).toBeLessThan(s);
    }
  });

  it('fades text out over TIP_TEXT_FADE instead of cutting it off', () => {
    expect(tipTextAlpha(TIP_TEXT_FADE[1])).toBe(1);
    expect(tipTextAlpha(TIP_TEXT_FADE[0])).toBe(0);
    const mid = tipTextAlpha((TIP_TEXT_FADE[0] + TIP_TEXT_FADE[1]) / 2);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });

  it('greeks the names where text has faded, and thins the greeking out in dense rows', () => {
    expect(tipGreekAlpha(TIP_TEXT_FADE[1])).toBe(0);
    expect(tipGreekAlpha(TIP_GREEK_SPACING[1])).toBe(TIP_GREEK_ALPHA);
    expect(tipGreekAlpha(TIP_GREEK_SPACING[0])).toBe(0);
    expect(tipColumnAlpha(TIP_GREEK_SPACING[0])).toBe(0);
    expect(TIP_GREEK_SPACING[1]).toBeLessThan(TIP_TEXT_FADE[0]);
  });

  it('never leaves the column empty between text and greeking', () => {
    // Somewhere in the column, text or greeking always shows, from the
    // greeking's top down to full text.
    for (const s of spacings) {
      if (s < TIP_GREEK_SPACING[1]) continue;
      expect(tipTextAlpha(s) + tipGreekAlpha(s) / TIP_GREEK_ALPHA).toBeGreaterThan(0.5);
    }
  });
});
