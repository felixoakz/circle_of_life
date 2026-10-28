// The panel's about section (DESIGN.md §4.2, §7; PLAN §6.3, §7.10): what
// /api/nodes/{ref}/about found, laid out under the core facts.
//
// Order: image with its credit line; the Wikipedia extract (or the
// generated sentence, then a labelled ancestor article); the IUCN status as
// plain text; "Where it lives" (GBIF density map and top countries). The
// authority and common names go into the panel head, the links into the
// facts list, and the per-source credits into the footer; the panel places
// those parts (ui/panel.ts).
//
// Every missing part says so in DESIGN.md §7's words, and a source that
// failed gets "Couldn't reach X. Retry" instead of pretending there is
// nothing.

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
export const COUNTRIES_SHOWN = 8;

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

/** The text of the generated sentence, its leading taxon name styled. */
export function generatedNodes(text: string, name: string | null, rank: string | null): (Node | string)[] {
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

export interface AboutHooks {
  /** Ask again, refetching a partial document. */
  retry: () => void;
  /** Opens the Data & credits dialog. */
  credits: () => void;
  /** The map's tiles have all loaded or failed. */
  settled: () => void;
}

/** The pieces of the about view, placed by the panel. */
export interface AboutView {
  /** Fills `.panel-about`. */
  section: HTMLElement[];
  /** Head lines under the context line: authority, common names. */
  head: HTMLElement[];
  /** The "Links" facts row, or null. */
  links: HTMLElement | null;
  /** Footer credit parts, joined with " · ". */
  credits: Child[][];
  /** Whether a map is loading (the panel stays busy until `settled`). */
  map: boolean;
}

/** Builds the about view for `node` from its document. `mapWidth` is the content width, CSS px. */
export function aboutView(doc: About, node: NodeInfo, mapWidth: number, hooks: AboutHooks): AboutView {
  const section: HTMLElement[] = [];
  const head: HTMLElement[] = [];
  const credits: Child[][] = [];
  const failed = new Set(doc.failed);

  // Head: the authority (roman, DESIGN.md §3) and common names.
  const authority = doc.taxonomy?.authorship;
  if (authority) {
    const p = el('p', 'panel-context about-authority', [authority]);
    if (doc.taxonomy?.publishedIn) p.title = doc.taxonomy.publishedIn;
    head.push(p);
  }
  if (doc.commonNames.length > 0) {
    const label = doc.commonNames.length === 1 ? 'Common name' : 'Common names';
    head.push(el('p', 'panel-context', [`${label}: ${doc.commonNames.join(', ')}`]));
  }

  // A source failed: say which, and offer to ask again (DESIGN.md §7).
  if (doc.failed.length > 0) {
    const again = el('button', 'text-button', ['Retry']);
    again.type = 'button';
    again.addEventListener('click', hooks.retry);
    section.push(el('p', 'panel-error about-failed', [`Couldn’t reach ${sourceList(doc.failed)}. `, again]));
  }

  // Image and credit line.
  const img = doc.image;
  if (img) {
    const figure = el('figure', 'about-figure');
    if (img.about) figure.append(el('p', 'about-label', ['Image of ', ...aboutName(img.about), ':']));
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
    pic.addEventListener('error', () => figure.remove(), { once: true });
    // "Image", not "Photo": Commons files are often drawings or plates.
    const credit = el('figcaption', 'about-credit', ['Image: ']);
    if (img.credit) credit.append(link(img.pageUrl, img.credit), ' · ');
    credit.append(img.licenseUrl ? link(img.licenseUrl, img.license) : img.license, ' · ');
    credit.append(img.credit ? img.source : link(img.pageUrl, img.source));
    figure.append(pic, credit);
    section.push(figure);
    credits.push([`Image: ${img.credit ? `${img.credit}, ` : ''}${img.license} via ${img.source}`]);
  } else if (!failed.has('Wikidata') && !failed.has('Wikimedia Commons') && !failed.has('iNaturalist')) {
    section.push(el('p', 'about-missing', ['No photo on Wikimedia Commons or iNaturalist.']));
  }

  // Text: the article, or the generated sentence plus a borrowed article.
  const sum = doc.summary;
  if (sum && !sum.about) {
    section.push(el('p', 'about-lead', [sum.text]));
  } else {
    section.push(el('p', 'about-lead', generatedNodes(doc.generated, node.name, node.rank)));
  }
  if (sum) {
    if (sum.about) {
      section.push(el('p', 'about-label', ['No Wikipedia article. About ', ...aboutName(sum.about), ':']));
      section.push(el('p', 'about-borrowed', [sum.text]));
    }
    section.push(
      el('p', 'about-source', [
        'From ',
        link(sum.url, 'Wikipedia'),
        ', ',
        link('https://creativecommons.org/licenses/by-sa/4.0/', sum.license),
        ' · ',
        link(sum.url, 'Read on Wikipedia'),
      ]),
    );
    credits.unshift([`Text: Wikipedia (${sum.license})`]);
  }

  // Conservation status, plain text (no badge).
  if (doc.status) {
    const via = `IUCN via ${doc.status.source}`;
    section.push(
      el('p', 'about-status', [
        statusLabel(doc.status.code),
        el('span', 'about-status-source', [' · ', doc.links.iucn ? link(doc.links.iucn, via) : via]),
      ]),
    );
  }

  // Where it lives: GBIF density map and the top countries.
  let map = false;
  const dist = doc.distribution;
  if (dist) {
    const where = el('div', 'about-where', [el('h3', 'about-heading', ['Where it lives'])]);
    if (dist.occurrences === 0) {
      where.append(el('p', 'about-missing', ['No occurrence records on GBIF.']));
    } else {
      const w = Math.max(200, Math.round(mapWidth));
      const box = occurrenceMap(dist.gbifKey, dist.bbox, w, Math.round(w / 2), hooks.settled);
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `Map of GBIF occurrence records of ${node.name ?? 'this taxon'}`);
      where.append(box);
      map = true;
      const records = `${nf.format(dist.occurrences)} ${dist.occurrences === 1 ? 'record' : 'records'}`;
      const countries =
        dist.countryTotal > 0 ? ` from ${nf.format(dist.countryTotal)} ${dist.countryTotal === 1 ? 'country' : 'countries'}` : '';
      where.append(el('p', 'about-records tabular', [`${records}${countries}`]));
      where.append(el('p', 'about-countries tabular', [countriesLine(dist.countries)]));
      where.append(
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

  return { section, head, links: links.childNodes.length > 0 ? links : null, credits, map };
}

/** The loading line (DESIGN.md §7: truthful, no spinner). */
export function aboutLoading(): HTMLElement {
  return el('p', 'about-loading', ['Fetching from Wikipedia, GBIF…']);
}

/** The whole request failed (server down, network gone). */
export function aboutError(retry: () => void): HTMLElement {
  const again = el('button', 'text-button', ['Retry']);
  again.type = 'button';
  again.addEventListener('click', retry);
  return el('p', 'panel-error about-failed', ['Couldn’t reach Wikipedia, GBIF and Wikidata. ', again]);
}
