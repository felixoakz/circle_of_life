import { describe, expect, it } from 'vitest';
import { RANGE_SIDE_SHARE, RANGE_TEXT_PX, countriesLine, countryName, leadText, mapSize, sentenceCase, sourceList, statusLabel } from './about';

describe('about helpers', () => {
  it('writes IUCN categories as text', () => {
    expect(statusLabel('NT')).toBe('Near Threatened (NT)');
    expect(statusLabel('CR')).toBe('Critically Endangered (CR)');
    expect(statusLabel('XX')).toBe('XX');
  });

  it('names countries, falling back to the code', () => {
    expect(countryName('BR')).toBe('Brazil');
    expect(countryName('ZZ')).toBe('Unknown');
    expect(countryName('not a code')).toBe('not a code');
  });

  it('lists the top countries with thousands separators', () => {
    const line = countriesLine([
      ['BR', 97224],
      ['PY', 21808],
      ['AR', 8956],
    ]);
    expect(line).toBe('Brazil 97,224 · Paraguay 21,808 · Argentina 8,956');
    expect(countriesLine([['BR', 1], ['PY', 1]], 1)).toBe('Brazil 1');
  });

  it('joins failed sources in prose', () => {
    expect(sourceList(['GBIF'])).toBe('GBIF');
    expect(sourceList(['Wikidata', 'GBIF'])).toBe('Wikidata and GBIF');
    expect(sourceList(['Wikidata', 'GBIF', 'iNaturalist'])).toBe('Wikidata, GBIF and iNaturalist');
  });
});

describe('leadText', () => {
  const text = 'One two three. Four five six seven. Eight nine ten eleven twelve.';
  it('keeps whole sentences that fit', () => {
    expect(leadText(text, 40)).toBe('One two three. Four five six seven.');
    expect(leadText(text, 200)).toBe(text);
  });

  it('keeps a long first sentence whole within half again, else cuts at a word', () => {
    expect(leadText(text, 12)).toBe('One two three.');
    expect(leadText('Alpha beta gamma delta epsilon zeta. Eta.', 10)).toBe('Alpha…');
  });

  it('writes common names in sentence case', () => {
    expect(sentenceCase('human')).toBe('Human');
    expect(sentenceCase('giant panda')).toBe('Giant panda');
  });
});

describe('mapSize', () => {
  it('fits a 2:1 map into the tab area above its text lines', () => {
    expect(mapSize(500, 400)).toEqual({ width: 500, height: 250 });
    expect(mapSize(700, 200 + RANGE_TEXT_PX)).toEqual({ width: 400, height: 200 });
    // A phone: beside the lines, at most RANGE_SIDE_SHARE of the width.
    expect(mapSize(340, 100, true).width).toBeLessThanOrEqual(340 * RANGE_SIDE_SHARE);
    const s = mapSize(342, 110);
    expect(s.height + RANGE_TEXT_PX).toBeLessThanOrEqual(Math.max(110, 60 + RANGE_TEXT_PX));
  });
});
