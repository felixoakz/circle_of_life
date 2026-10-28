import { describe, expect, it } from 'vitest';
import { type NameRun, abbreviateGenus, isPlaceholderName, italicName, nameRuns } from './names';

/** Writes runs as text with *italic* parts, for readable expectations. */
function show(runs: NameRun[]): string {
  return runs.map((r) => (r.italic ? `*${r.text}*` : r.text)).join('');
}

describe('nameRuns', () => {
  it('sets binomials and trinomials in italic', () => {
    expect(show(nameRuns('Homo sapiens'))).toBe('*Homo sapiens*');
    expect(show(nameRuns('Pan troglodytes verus'))).toBe('*Pan troglodytes verus*');
  });

  it('keeps rank markers roman (review P1-2 examples)', () => {
    expect(show(nameRuns('Quercus petraea subsp. petraea'))).toBe('*Quercus petraea* subsp. *petraea*');
    expect(show(nameRuns('Amanita muscaria var. guessowii Koide BX008'))).toBe(
      '*Amanita muscaria* var. *guessowii* Koide BX008',
    );
    expect(show(nameRuns('Amanita muscaria Koide BX008'))).toBe('*Amanita muscaria* Koide BX008');
    expect(show(nameRuns('Rosa canina f. blondaeana'))).toBe('*Rosa canina* f. *blondaeana*');
    expect(show(nameRuns('Amanita cf. muscaria'))).toBe('*Amanita* cf. *muscaria*');
  });

  it('sets everything after sp. and strain codes roman', () => {
    expect(show(nameRuns('Pantoea sp. NCCP-140'))).toBe('*Pantoea* sp. NCCP-140');
    expect(show(nameRuns('Escherichia coli KTE178'))).toBe('*Escherichia coli* KTE178');
    expect(show(nameRuns('Halobacterium salinarum (strain Shark)'))).toBe(
      '*Halobacterium salinarum* (strain Shark)',
    );
    expect(show(nameRuns('Escherichia coli str. K-12 substr. MG1655'))).toBe(
      '*Escherichia coli* str. K-12 substr. MG1655',
    );
  });

  it('keeps Candidatus roman', () => {
    expect(show(nameRuns('Candidatus Pelagibacter ubique', 'species'))).toBe('Candidatus *Pelagibacter ubique*');
  });

  it('sets higher ranks roman, and genera italic when known', () => {
    expect(show(nameRuns('Mammalia', 'class'))).toBe('Mammalia');
    expect(show(nameRuns('Felidae'))).toBe('Felidae');
    expect(show(nameRuns('Panthera', 'genus'))).toBe('*Panthera*');
    expect(show(nameRuns('Panthera', null, true))).toBe('*Panthera*');
    expect(show(nameRuns('BD1-5'))).toBe('BD1-5');
  });

  it('gives the name back when the runs are joined', () => {
    for (const n of ['Quercus petraea subsp. petraea', 'Pantoea sp. NCCP-140', 'Homo sapiens', 'Felidae']) {
      expect(
        nameRuns(n)
          .map((r) => r.text)
          .join(''),
      ).toBe(n);
    }
  });
});

describe('isPlaceholderName', () => {
  it('spots OTT placeholders', () => {
    expect(isPlaceholderName('h2007-2')).toBe(true);
    expect(isPlaceholderName('Fungi incertae sedis')).toBe(true);
    expect(isPlaceholderName('unclassified Bacteria')).toBe(true);
    expect(isPlaceholderName('Homo')).toBe(false);
    expect(isPlaceholderName('BD1-5')).toBe(false);
  });
});

describe('italicName (shape rules)', () => {
  it('follows the rank when known', () => {
    expect(italicName('Panthera', 'genus')).toBe(true);
    expect(italicName('Felidae', 'family')).toBe(false);
    expect(italicName('Homo sapiens sapiens', 'no rank')).toBe(true);
  });

  it('guesses from the name shape without a rank', () => {
    expect(italicName('Panthera onca', null)).toBe(true);
    expect(italicName('Mammalia', null)).toBe(false);
    expect(italicName('Mammalia', null, true)).toBe(true);
    expect(italicName('cellular organisms', null)).toBe(false);
  });
});

describe('abbreviateGenus', () => {
  it('cuts the genus to its initial', () => {
    expect(abbreviateGenus(nameRuns('Dolichopithecus ruscinensis', 'species'))).toEqual([
      { text: 'D. ruscinensis', italic: true },
    ]);
    const sub = abbreviateGenus(nameRuns('Quercus petraea subsp. petraea', 'subspecies'));
    expect(sub?.map((r) => r.text).join('')).toBe('Q. petraea subsp. petraea');
    expect(abbreviateGenus(nameRuns('Felidae', 'family'))).toBeNull();
    expect(abbreviateGenus(nameRuns('Homo', 'genus'))).toBeNull();
  });
});
