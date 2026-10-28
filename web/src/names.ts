// Taxon name styling (DESIGN.md §3), shared by the canvas labels, the HUD
// breadcrumb, and later the panel, search rows and tooltips (P8, P9).
//
// Only genus, species and infraspecific names are italic, and within such a
// name only the Latin parts are: the genus and the lowercase epithets. Rank
// markers ("subsp.", "var."), qualifiers ("cf.", "aff."), "Candidatus", and
// informal parts (strain codes, "sp. NCCP-140", "(strain Shark)", quoted
// names) are roman:
//
//   Quercus petraea subsp. petraea   → *Quercus petraea* subsp. *petraea*
//   Amanita muscaria var. guessowii Koide BX008
//                                    → *Amanita muscaria* var. *guessowii* Koide BX008
//   Pantoea sp. NCCP-140             → *Pantoea* sp. NCCP-140
//
// `nameRuns` returns the name cut into runs of one style; the callers pick
// the faces (serif italic, sans roman).

/** A piece of a name in one style. Concatenating the runs' text gives the name back. */
export interface NameRun {
  text: string;
  italic: boolean;
}

/** Taxon names in italic: genus and below (DESIGN.md §3). */
const ITALIC_RANKS = new Set([
  'genus',
  'subgenus',
  'section',
  'subsection',
  'series',
  'species group',
  'species subgroup',
  'species',
  'subspecies',
  'variety',
  'varietas',
  'subvariety',
  'forma',
  'form',
  'subform',
  'infraspecificname',
]);

/** "Genus species…": a capitalised word, then a lowercase one. */
const BINOMIAL = /^[A-Z][a-z-]+ (?:\([A-Z][a-z]+\) )?[a-z]/;

/**
 * Whether a taxon name is (partly) italic. With the rank known (the API),
 * genus and below are; without it (tiles carry only a species flag), species
 * and names shaped like binomials or trinomials are, and `genus` says
 * whether the node is known to be a genus (it has a species child).
 */
export function italicName(name: string, rank: string | null, genus = false): boolean {
  if (rank && ITALIC_RANKS.has(rank)) return true;
  return genus || BINOMIAL.test(name);
}

/** Rank markers and qualifiers: roman, and the Latin after them stays italic. */
const MARKERS = new Set([
  'subsp.',
  'ssp.',
  'var.',
  'subvar.',
  'f.',
  'fo.',
  'forma',
  'subf.',
  'cf.',
  'aff.',
  'nr.',
  'sect.',
  'subsect.',
  'ser.',
  'subg.',
  'subgen.',
  'nothosubsp.',
  'nothovar.',
  'x',
  '×',
  'Candidatus',
]);

/** After these, the rest of the name is informal and roman ("sp. NCCP-140"). */
const INFORMAL_AFTER = new Set(['sp.', 'spp.', 'str.', 'strain', 'substr.', 'isolate', 'clone', 'genomosp.', 'sp']);

/** A Latin name word: letters (any script's lowercase), hyphens, and a trailing period never. */
const LATIN_EPITHET = /^[\p{Ll}][\p{Ll}-]*$/u;
const LATIN_GENUS = /^[\p{Lu}][\p{Ll}-]+$/u;

/**
 * Cuts `name` into italic and roman runs (see the file comment). `rank` is
 * the OTT rank when known (the API); `genus` says a rankless tile name is
 * known to be a genus.
 */
export function nameRuns(name: string, rank: string | null = null, genus = false): NameRun[] {
  if (!name) return [];
  if (!italicName(name, rank, genus)) return [{ text: name, italic: false }];
  const words = name.split(' ');
  const styles: boolean[] = [];
  let informal = false;
  let seenGenus = false;
  for (const w of words) {
    let italic = false;
    if (informal || MARKERS.has(w)) {
      italic = false;
    } else if (INFORMAL_AFTER.has(w)) {
      informal = true;
    } else if (!seenGenus && LATIN_GENUS.test(w)) {
      italic = true;
      seenGenus = true;
    } else if (seenGenus && LATIN_EPITHET.test(w)) {
      italic = true;
    } else if (seenGenus) {
      // A strain code, a capitalised or quoted informal name, digits,
      // parentheses: the rest is not Latin.
      informal = true;
    }
    styles.push(italic);
  }
  // Join the words back, a space taking the style of the word after it
  // unless that word is italic and the one before is not (spaces between
  // styles are roman, which keeps italic runs tight).
  const runs: NameRun[] = [];
  words.forEach((w, i) => {
    const italic = styles[i] ?? false;
    const text = i === 0 ? w : ' ' + w;
    const last = runs[runs.length - 1];
    if (i > 0 && italic && last && !last.italic) {
      last.text += ' ';
      runs.push({ text: w, italic });
    } else if (last && last.italic === italic) {
      last.text += text;
    } else {
      runs.push({ text, italic });
    }
  });
  return runs;
}

/**
 * OTT placeholder and bookkeeping names that are not taxa a reader would
 * recognise: "h2007-2" style codes and "incertae sedis" / "unclassified" /
 * "environmental samples" containers. Labels and the breadcrumb skip them.
 */
export function isPlaceholderName(name: string): boolean {
  return (
    /^h\d{4}-\d+$/.test(name) ||
    /\bincertae sedis\b/i.test(name) ||
    /^unclassified\b/i.test(name) ||
    /^environmental samples\b/i.test(name)
  );
}

/** DOM spans for a name: italic runs get the `.taxon-italic` class (serif italic). */
export function nameSpans(runs: readonly NameRun[]): HTMLSpanElement[] {
  return runs.map((r) => {
    const s = document.createElement('span');
    if (r.italic) s.className = 'taxon-italic';
    s.textContent = r.text;
    return s;
  });
}

/**
 * The name with its genus cut to an initial ("Dolichopithecus ruscinensis"
 * → "D. ruscinensis"), the botanist's and zoologist's own short form, for
 * a tip label that would not fit on screen otherwise. Null when the name
 * does not start with an italic genus followed by more.
 */
export function abbreviateGenus(runs: readonly NameRun[]): NameRun[] | null {
  const first = runs[0];
  if (!first?.italic) return null;
  const m = /^([A-Z])[a-z-]+ (?=\S)/.exec(first.text);
  if (!m) return null;
  return [{ text: `${m[1]}. ${first.text.slice(m[0].length)}`, italic: true }, ...runs.slice(1)];
}
