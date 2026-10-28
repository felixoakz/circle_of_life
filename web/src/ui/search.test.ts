import { describe, expect, it } from 'vitest';
import { nameRuns } from '../names';
import type { SearchHit } from '../types';
import { compactCount, isHomeHit, markRuns, matchRanges, moveActive, normaliseQuery, opensPalette, paletteAction } from './search';

describe('matchRanges', () => {
  it('marks word prefixes, ignoring case and diacritics', () => {
    expect(matchRanges('Homo sapiens', 'homo sap')).toEqual([
      [0, 4],
      [5, 8],
    ]);
    expect(matchRanges('Homo sapiens', 'SAP')).toEqual([[5, 8]]);
    expect(matchRanges('onça-pintada', 'onca')).toEqual([[0, 4]]);
    expect(matchRanges('Onca', 'onça')).toEqual([[0, 4]]);
    // Only word starts: "pien" is inside a word.
    expect(matchRanges('Homo sapiens', 'pien')).toEqual([]);
    // Words after punctuation start a word too (the tokenizer splits there).
    expect(matchRanges('Pantoea sp. NCCP-140', 'nccp 140')).toEqual([
      [12, 16],
      [17, 20],
    ]);
  });

  it('merges overlapping marks', () => {
    expect(matchRanges('Homo', 'homo ho')).toEqual([[0, 4]]);
  });
});

describe('markRuns', () => {
  it('cuts italic runs where the match ends', () => {
    const runs = markRuns(nameRuns('Homo sapiens', 'species'), matchRanges('Homo sapiens', 'homo sap'));
    expect(runs).toEqual([
      { text: 'Homo', italic: true, strong: true },
      { text: ' ', italic: true, strong: false },
      { text: 'sap', italic: true, strong: true },
      { text: 'iens', italic: true, strong: false },
    ]);
    expect(runs.map((r) => r.text).join('')).toBe('Homo sapiens');
  });

  it('keeps roman parts roman', () => {
    const name = 'Quercus petraea subsp. petraea';
    const runs = markRuns(nameRuns(name, 'subspecies'), matchRanges(name, 'quercus'));
    expect(runs[0]).toEqual({ text: 'Quercus', italic: true, strong: true });
    expect(runs.find((r) => r.text.includes('subsp.'))?.italic).toBe(false);
    expect(runs.map((r) => r.text).join('')).toBe(name);
  });
});

describe('keyboard', () => {
  it('maps keys to palette actions', () => {
    expect(paletteAction('ArrowDown')).toBe('next');
    expect(paletteAction('ArrowUp')).toBe('prev');
    expect(paletteAction('Enter')).toBe('choose');
    expect(paletteAction('Escape')).toBe('close');
    // Home/End and letters stay with the text field.
    expect(paletteAction('Home')).toBe(null);
    expect(paletteAction('a')).toBe(null);
  });

  it('moves the active option, wrapping at both ends', () => {
    expect(moveActive(0, 3, 'next')).toBe(1);
    expect(moveActive(2, 3, 'next')).toBe(0);
    expect(moveActive(0, 3, 'prev')).toBe(2);
    expect(moveActive(-1, 3, 'next')).toBe(0);
    expect(moveActive(-1, 3, 'prev')).toBe(2);
    expect(moveActive(1, 3, 'last')).toBe(2);
    expect(moveActive(1, 3, 'first')).toBe(0);
    expect(moveActive(0, 0, 'next')).toBe(-1);
  });

  it('opens on "/" outside text fields and on ⌘K / Ctrl+K anywhere', () => {
    const key = { key: '/', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, editable: false };
    expect(opensPalette(key)).toBe(true);
    expect(opensPalette({ ...key, editable: true })).toBe(false);
    expect(opensPalette({ ...key, key: 'k', metaKey: true })).toBe(true);
    expect(opensPalette({ ...key, key: 'k', ctrlKey: true, editable: true })).toBe(true);
    expect(opensPalette({ ...key, key: 'k' })).toBe(false);
    expect(opensPalette({ ...key, key: 'k', ctrlKey: true, shiftKey: true })).toBe(false);
  });
});

describe('text', () => {
  it('normalises queries and formats the trigger count', () => {
    expect(normaliseQuery('  homo   sap ')).toBe('homo sap');
    expect(compactCount(2_273_995)).toBe('2.3M');
  });
});

describe('isHomeHit', () => {
  const tipCount = 2_385_875;
  const slot = 2 ** 32 / tipCount;
  const home = { angle: 1_780_855_860 };
  const hit = (flags: number, childCount: number, angle: number): SearchHit =>
    ({ flags, childCount, angle }) as unknown as SearchHit;

  it('is white for Homo sapiens and its subspecies only', () => {
    expect(isHomeHit(hit(8, 2, home.angle), home, tipCount)).toBe(true);
    expect(isHomeHit(hit(0, 0, home.angle - slot / 2), home, tipCount)).toBe(true);
    expect(isHomeHit(hit(0, 0, home.angle + slot / 2), home, tipCount)).toBe(true);
    // The next tip over (Homo erectus side) and the genus are not.
    expect(isHomeHit(hit(0, 0, home.angle + slot * 1.5), home, tipCount)).toBe(false);
    expect(isHomeHit(hit(0, 5, home.angle), home, tipCount)).toBe(false);
    expect(isHomeHit(hit(0, 0, home.angle), null, tipCount)).toBe(false);
  });
});
