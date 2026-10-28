import { describe, expect, it } from 'vitest';
import { countriesLine, countryName, sourceList, statusLabel } from './about';

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
