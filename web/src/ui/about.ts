// The card's about tabs (DESIGN.md §4.2, §7; ARCHITECTURE §6.3, §7.10): what
// /api/nodes/{ref}/about found, as the Overview tab (image beside the
// extract, status) and the Range tab (map sized to the tab, records,
// countries), for ui/panel.ts to place.
//
// Order: image with its credit line; the Wikipedia extract (or the
// generated sentence, then a labelled ancestor article), cut to whole
// sentences that fit the card's first screen; the IUCN status as plain
// text; "Where it lives" (GBIF density map and top countries). The
// authority and the common name go into the panel head, the links into the
// facts list, and the per-source credits into the footer; the panel places
// those parts (ui/panel.ts).
//
// Every missing part says so in DESIGN.md §7's words, quietly at the end,
// except a missing image, which is simply left out. A source that failed
// gets "Couldn't reach X. Retry" in text-3 where its part would be (the
// image, the text, the map) rather than pretending there is nothing; only
// a whole failure (aboutError) is in --danger.

import { nameRuns, nameSpans } from '../names';
import type { About, NodeInfo } from '../types';
import { occurrenceMap } from './occmap';

const nf = new Intl.NumberFormat('en');

/** IUCN Red List categories (the codes the server sends). */
const IUCN: Record<string, string> = {
  LC: 'Least Concern',
  NT: 'Near Threatened',
  VU: 'Vulnerable',
  EN: 'Endangered',
  CR: 'Critically Endangered',
  EW: 'Extinct in the Wild',
  EX: 'Extinct',
  DD: 'Data Deficient',
};

/** "Near Threatened (NT)", or the bare code if unknown. */
export function statusLabel(code: string): string {
  const name = IUCN[code];
  return name ? `${name} (${code})` : code;
}

let regionNames: Intl.DisplayNames | null = null;

/** "Brazil" for "BR"; the code itself when the browser has no name for it. */
export function countryName(code: string): string {
  if (code === 'ZZ') return 'Unknown'; // GBIF's "no country"
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    const name = regionNames.of(code);
    return name && name !== code ? name : code;
  } catch {
    return code; // not a valid region code (GBIF's "ZZ", "XZ")
  }
}

/** Countries shown under the map. */
const COUNTRIES_SHOWN = 8;

/** "Brazil 97,224 · Paraguay 21,808 · …", the top few. */
export function countriesLine(countries: readonly [string, number][], limit = COUNTRIES_SHOWN): string {
  return countries
    .slice(0, limit)
    .map(([code, n]) => `${countryName(code)} ${nf.format(n)}`)
    .join(' · ');
}

/** "Wikidata", "Wikidata and GBIF", "Wikidata, GBIF and iNaturalist". */
export function sourceList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Characters per line of 15 px body text, roughly, per px of width. */
const CHARS_PER_PX = 1 / 7.6;

/** A first sentence up to this many times `maxChars` is kept whole (the CSS clamp is 6 lines for 4). */
const LONG_FIRST = 1.5;

/**
 * The extract cut to whole sentences within `maxChars`, so the card's first
 * screen ends on a full stop rather than an ellipsis mid-line. A first
 * sentence longer than that is cut at a word and gets "…".
 */
export function leadText(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  // Sentence ends: ". " followed by a capital (not "e.g. a" or "sp. nov").
  const ends = [...t.matchAll(/[.!?](?=\s+[A-Z“"(])/g)].map((m) => (m.index ?? 0) + 1);
  let cut = 0;
  for (const e of ends) {
    if (e > maxChars) break;
    cut = e;
  }
  if (cut > 0) return t.slice(0, cut);
  // A long first sentence still reads better whole, up to the clamp's room.
  const first = ends[0];
  if (first !== undefined && first <= maxChars * LONG_FIRST) return t.slice(0, first);
  const words = t.slice(0, maxChars).replace(/\s+\S*$/, '');
  return `${words.replace(/[.,;:]$/, '')}…`;
}

/** A common name in sentence case: "human" → "Human", "giant panda" → "Giant panda". */
export function sentenceCase(name: string): string {
  return name ? name.charAt(0).toLocaleUpperCase('en') + name.slice(1) : name;
}

/** The text of the generated sentence, its leading taxon name styled. */
function generatedNodes(text: string, name: string | null, rank: string | null): (Node | string)[] {
  if (!name || !text.startsWith(name)) return [text];
  return [...nameSpans(nameRuns(name, rank)), text.slice(name.length)];
}

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', children: Child[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

function link(href: string, text: Child[] | string): HTMLAnchorElement {
  const a = el('a', '', typeof text === 'string' ? [text] : text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** "the genus Panthera" for an ancestor's article or image. */
function aboutName(about: { name: string; rank: string | null }): Child[] {
  const rank = about.rank && !about.rank.startsWith('no rank') ? `the ${about.rank} ` : '';
  return [rank, ...nameSpans(nameRuns(about.name, about.rank))];
}

/** Sources whose failure leaves the image missing (Wikidata names the Commons file). */
const IMAGE_SOURCES = new Set(['Wikidata', 'Wikimedia Commons', 'iNaturalist']);

/** "Couldn't reach GBIF. Retry" in text-3, where the missing part would be. */
function notice(sources: readonly string[], retry: () => void): HTMLElement {
  const again = el('button', 'text-button', ['Retry']);
  again.type = 'button';
  again.addEventListener('click', retry);
  return el('p', 'about-notice', [`Couldn’t reach ${sourceList(sources)}. `, again]);
}

export interface AboutHooks {
  /** Ask again, refetching a partial document. */
  retry: () => void;
  /** Opens the Data & credits dialog. */
  credits: () => void;
  /** The map's tiles have all loaded or failed. */
  settled: () => void;
}

/** The pieces of the about view, placed by the panel's tabs (ui/panel.ts). */
export interface AboutView {
  /** The Overview tab: the image beside the text column (extract, source, status, notices). */
  overview: HTMLElement[];
  /** The Range tab (map, records, countries), or null when there is nothing to show. */
  range: HTMLElement[] | null;
  /** The authority for the head's meta line ("Linnaeus, 1758"), or null. */
  authority: HTMLElement | null;
  /** The best English common name, sentence case, for the head's lead line, or null. */
  common: string | null;
  /** The "Links" facts row, or null. */
  links: HTMLElement | null;
  /** Footer credit parts, joined with " · ". */
  credits: Child[][];
  /** Whether a map is loading (the panel stays busy until `settled`). */
  map: boolean;
  /**
   * Phone only: the image, square, for the card's head (beside the name), or
   * null. Its credit line is then in the Overview text instead.
   */
  headImage: HTMLElement | null;
}

/** Room under the map for the records, countries and credit lines, CSS px. */
export const RANGE_TEXT_PX = 76;
/** On a phone the lines go beside the map instead, which takes at most this share of the width. */
export const RANGE_SIDE_SHARE = 0.56;

/**
 * The map's size for a tab area of `w` × `h` CSS px: as large as fits, 2:1
 * (GBIF's map is equirectangular), leaving RANGE_TEXT_PX for the lines under
 * it, or (`side`, a phone's short tab) RANGE_SIDE_SHARE of the width beside them.
 */
export function mapSize(w: number, h: number, side = false): { width: number; height: number } {
  const height = side
    ? Math.max(40, Math.floor(Math.min(h, (w * RANGE_SIDE_SHARE) / 2)))
    : Math.max(60, Math.floor(Math.min(h - RANGE_TEXT_PX, w / 2)));
  return { width: height * 2, height };
}

/**
 * Builds the about view for `node` from its document. `area` is the tab
 * area, CSS px (the map is sized to fit it); `lines` how many lines of
 * extract to start from (the panel's fitter takes sentences off until the
 * Overview tab fits).
 */
export function aboutView(
  doc: About,
  node: NodeInfo,
  area: { width: number; height: number },
  hooks: AboutHooks,
  lines = 6,
  compact = false,
): AboutView {
  const section: HTMLElement[] = [];
  const text: HTMLElement[] = [];
  let figure: HTMLElement | null = null;
  let imageCredit: HTMLElement | null = null;
  const credits: Child[][] = [];
  const failed = new Set(doc.failed);
  const notes: HTMLElement[] = [];

  // Head: the authority (roman, DESIGN.md §3) and the best common name.
  let authority: HTMLElement | null = null;
  if (doc.taxonomy?.authorship) {
    authority = el('span', 'about-authority', [doc.taxonomy.authorship]);
    if (doc.taxonomy.publishedIn) authority.title = doc.taxonomy.publishedIn;
  }
  const first = doc.commonNames[0];
  const common = first ? sentenceCase(first) : null;

  // Image and credit line.
  const img = doc.image;
  const imageFailed = doc.failed.filter((f) => IMAGE_SOURCES.has(f));
  if (img) {
    figure = el('figure', 'about-figure');
    const fig = figure;
    if (img.about && !compact) figure.append(el('p', 'about-label', ['Image of ', ...aboutName(img.about), ':']));
    // Commons renders SVG diagrams (Human.svg) as PNGs with transparent
    // backgrounds: dark line art that would vanish on black. They go on a
    // light plate, whole (contain), like a herbarium sheet.
    const plate = /\.svg\.png$/i.test(img.url);
    const pic = el('img', plate ? 'about-image about-plate' : 'about-image');
    pic.src = img.url;
    pic.alt = doc.summary?.description ?? `Image of ${node.name ?? 'this taxon'}`;
    pic.decoding = 'async';
    pic.loading = 'eager';
    if (img.width && img.height) {
      pic.width = img.width;
      pic.height = img.height;
    }
    // A broken image link leaves only the credit; better nothing at all.
    pic.addEventListener('error', () => {
      fig.remove();
      imageCredit?.remove();
    }, { once: true });
    // "Image", not "Photo": Commons files are often drawings or plates.
    const licence = img.licenseUrl ? link(img.licenseUrl, img.license) : img.license;
    if (compact) {
      // A phone's tab is too short for an image beside the text: it goes to
      // the head as a square (panel.ts), and its credit is one line of the text.
      imageCredit = el('p', 'about-source about-image-source', ['Image: ', licence, ' · ', link(img.pageUrl, img.credit || img.source)]);
      figure.append(pic);
    } else {
      const credit = el('figcaption', 'about-credit', ['Image: ']);
      if (img.credit) credit.append(link(img.pageUrl, img.credit), ' · ');
      credit.append(licence, ' · ');
      credit.append(img.credit ? img.source : link(img.pageUrl, img.source));
      figure.append(pic, credit);
    }
    credits.push([`Image: ${img.credit ? `${img.credit}, ` : ''}${img.license} via ${img.source}`]);
  } else if (imageFailed.length > 0) {
    text.push(notice(imageFailed, hooks.retry));
  }
  // No image and no failure: nothing at all, not even a note.

  // Text: the article, or the generated sentence plus a borrowed article.
  // Cut to whole sentences; the panel takes sentences off until it fits
  // (data-full keeps the whole extract for that).
  const textWidth = img && !compact ? area.width * 0.6 - 16 : area.width;
  const perLine = textWidth * CHARS_PER_PX;
  const sum = doc.summary;
  if (sum && !sum.about) {
    const lead = el('p', 'about-lead', [leadText(sum.text, Math.max(120, Math.round(perLine * lines)))]);
    lead.dataset.full = sum.text;
    lead.dataset.perLine = String(perLine);
    text.push(lead);
  } else {
    text.push(el('p', 'about-lead', generatedNodes(doc.generated, node.name, node.rank)));
  }
  if (failed.has('Wikipedia')) text.push(notice(['Wikipedia'], hooks.retry));
  if (sum) {
    if (sum.about) {
      text.push(el('p', 'about-label', ['No Wikipedia article. About ', ...aboutName(sum.about), ':']));
      const borrowed = el('p', 'about-borrowed', [leadText(sum.text, Math.max(120, Math.round(perLine * 3)))]);
      borrowed.dataset.full = sum.text;
      borrowed.dataset.perLine = String(perLine * 1.15);
      text.push(borrowed);
    }
    // A phone's short tab gets the one-line form: the article and its licence.
    text.push(
      el(
        'p',
        'about-source',
        compact
          ? [link(sum.url, 'Read on Wikipedia'), ' · ', link('https://creativecommons.org/licenses/by-sa/4.0/', sum.license)]
          : [
              'From ',
              link(sum.url, 'Wikipedia'),
              ', ',
              link('https://creativecommons.org/licenses/by-sa/4.0/', sum.license),
              ' · ',
              link(sum.url, 'Read on Wikipedia'),
            ],
      ),
    );
    credits.unshift([`Text: Wikipedia (${sum.license})`]);
  }

  // Conservation status, plain text (no badge).
  if (doc.status) {
    const via = `IUCN via ${doc.status.source}`;
    text.push(
      el('p', 'about-status', [
        statusLabel(doc.status.code),
        el('span', 'about-status-source', [' · ', doc.links.iucn ? link(doc.links.iucn, via) : via]),
      ]),
    );
  }

  // Where it lives (the Range tab): GBIF density map and the top countries.
  let map = false;
  const dist = doc.distribution;
  if (!dist && failed.has('GBIF')) section.push(notice(['GBIF'], hooks.retry));
  if (dist) {
    const where = el('div', compact ? 'about-where about-where-side' : 'about-where');
    if (dist.occurrences === 0) {
      where.append(el('p', 'about-missing', ['No occurrence records on GBIF.']));
    } else {
      const size = mapSize(area.width, area.height, compact);
      const box = occurrenceMap(dist.gbifKey, dist.bbox, size.width, size.height, hooks.settled);
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `Map of GBIF occurrence records of ${node.name ?? 'this taxon'}`);
      where.append(box);
      map = true;
      const records = `${nf.format(dist.occurrences)} ${dist.occurrences === 1 ? 'record' : 'records'}`;
      const countries =
        dist.countryTotal > 0 ? ` from ${nf.format(dist.countryTotal)} ${dist.countryTotal === 1 ? 'country' : 'countries'}` : '';
      const lines = el('div', 'about-where-text');
      lines.append(el('p', 'about-records tabular', [`${records}${countries}`]));
      const line = countriesLine(dist.countries);
      const top = el('p', 'about-countries tabular', [line]);
      top.title = line;
      lines.append(top);
      where.append(lines);
      lines.append(
        el('p', 'about-map-credit', [
          'Occurrences © ',
          link(`https://www.gbif.org/species/${dist.gbifKey}`, 'GBIF.org'),
          ' · Base map © ',
          link('https://openmaptiles.org/', 'OpenMapTiles'),
          ' © ',
          link('https://www.openstreetmap.org/copyright', 'OpenStreetMap'),
        ]),
      );
    }
    section.push(where);
    credits.push(['Occurrences: GBIF.org']);
  }

  // Any other source that failed, and what is simply missing, at the end.
  const placed = new Set(['Wikipedia', 'GBIF', ...(img ? [] : imageFailed)]);
  const rest = doc.failed.filter((f) => !placed.has(f));
  if (rest.length > 0) text.push(notice(rest, hooks.retry));
  text.push(...notes);
  // A phone's image credit follows the article's source line.
  if (imageCredit) {
    const at = text.findIndex((t) => t.classList.contains('about-source'));
    text.splice(at < 0 ? text.length : at + 1, 0, imageCredit);
  }
  // Overview: the text column, and the image beside it (no image, or a
  // phone's image in the head: the text takes the width).
  const column = el('div', 'ov-text', text);
  const beside = figure && !compact ? figure : null;
  const overview = [el('div', beside ? 'ov' : 'ov ov-solo', beside ? [column, beside] : [column])];

  // Links out (the facts list's "Links" row).
  const out: [string, string | null][] = [
    ['Wikipedia', doc.links.wikipedia],
    ['GBIF', doc.links.gbif],
    ['iNaturalist', doc.links.inat],
    ['Wikidata', doc.links.wikidata],
    ['Open Tree', doc.links.opentree],
  ];
  const links = el('span', 'about-links');
  for (const [label, href] of out) {
    if (!href) continue;
    if (links.childNodes.length > 0) links.append(' · ');
    links.append(link(href, label));
  }

  return {
    overview,
    range: section.length > 0 ? section : null,
    authority,
    common,
    links: links.childNodes.length > 0 ? links : null,
    credits,
    map,
    headImage: compact ? figure : null,
  };
}

/** The loading line (DESIGN.md §7: truthful, no spinner), in the tab that waits. */
export function aboutLoading(text = 'Fetching from Wikipedia, GBIF…'): HTMLElement {
  return el('p', 'about-loading', [text]);
}

/** The whole request failed (server down, network gone). */
export function aboutError(retry: () => void): HTMLElement {
  const again = el('button', 'text-button', ['Retry']);
  again.type = 'button';
  again.addEventListener('click', retry);
  return el('p', 'panel-error about-failed', ['Couldn’t reach Wikipedia, GBIF and Wikidata. ', again]);
}
