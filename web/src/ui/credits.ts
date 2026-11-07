// "Data & credits" (DESIGN.md §7, docs/data-sources.md §3): every source,
// licence and citation in one dialog, opened from the "i" button before the search bar
// (DESIGN.md §4.1) and from the panel footer.
//
// A native <dialog> opened with showModal(): it traps focus, closes on Esc,
// and gives focus back to whatever opened it. Opaque surface, hairline
// border, no blur; the backdrop is a flat dim.

import { track } from '../analytics';
import type { Meta } from '../types';

const nf = new Intl.NumberFormat('en');

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', children: Child[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', '', [text]);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** A mailto link (the author's contact; the upstream User-Agent contact is SPECIES_CONTACT). */
function mail(address: string): HTMLAnchorElement {
  const a = el('a', '', [address]);
  a.href = `mailto:${address}`;
  return a;
}

function doi(id: string): HTMLAnchorElement {
  return link(`https://doi.org/${id}`, `doi:${id}`);
}

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>';

/** "16.1" from "otl16.1-ott3.7.3-…". */
function synth(dataVersion: string): string {
  return /^otl([\d.]+)/.exec(dataVersion)?.[1] ?? '';
}

export class Credits {
  private readonly dialog: HTMLDialogElement;

  constructor(meta: Meta) {
    const close = el('button', 'ctl credits-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => this.dialog.close());

    const otherTips = meta.tipCount - meta.speciesCount;
    const section = (title: string, ...body: HTMLElement[]): HTMLElement =>
      el('section', 'credits-section', [el('h3', 'credits-heading', [title]), ...body]);
    const p = (...children: Child[]): HTMLParagraphElement => el('p', '', children);

    // The scale up front: three figures, then the sources in two columns.
    const stat = (value: string, label: string): HTMLElement =>
      el('div', 'credits-stat', [el('span', 'credits-stat-value', [value]), el('span', 'credits-stat-label', [label])]);
    const release = synth(meta.dataVersion);
    this.dialog = el('dialog', 'credits', [
      el('div', 'credits-head', [
        el('div', 'credits-titles', [
          el('h2', 'credits-title', ['Data & credits']),
          el('p', 'credits-sub', ['Where every branch, name, photo and map on the wheel comes from.']),
          el('p', 'credits-by', [
            'Made by Felix · ',
            mail('felix@oakz.org'),
            ' · ',
            link('https://www.linkedin.com/in/felixoakz/', 'LinkedIn'),
            ' · ',
            link('https://github.com/felixoakz/circle_of_life', 'Source on GitHub'),
          ]),
        ]),
        close,
      ]),
      el('div', 'credits-stats', [
        stat(nf.format(meta.tipCount), 'tips on the rim'),
        stat(nf.format(meta.speciesCount), 'of them species'),
        stat(release || '–', 'OpenTree synthesis release'),
      ]),
      el('div', 'credits-body', [
        section(
          'Tree',
          p(
            link('https://tree.opentreeoflife.org/about/synthesis-release', `Open Tree of Life synthetic tree opentree${synth(meta.dataVersion)}`),
            ' and ',
            link('https://tree.opentreeoflife.org/about/taxonomy-version', 'Open Tree Taxonomy 3.7.3'),
            ' (CC0). ',
            doi('10.5281/zenodo.3937741'),
            ', ',
            doi('10.5281/zenodo.3937750'),
            '.',
          ),
          p(
            'Hinchliff, C. E. et al. (2015). Synthesis of phylogeny and taxonomy into a comprehensive tree of life. PNAS 112(41):12764–12769. ',
            doi('10.1073/pnas.1423041112'),
            '.',
          ),
          p(
            'Rees, J. A. & Cranston, K. (2017). Automated assembly of a reference taxonomy for phylogenetic data synthesis. Biodiversity Data Journal 5:e12581.',
          ),
        ),
        section(
          'Common names',
          p('GBIF Backbone Taxonomy (2023), CC BY 4.0, ', doi('10.15468/39omei'), '.'),
        ),
        section(
          'Reading the wheel',
          p(
            `The ${nf.format(otherTips)} tips that are not species-rank are subspecies, varieties and unranked terminal taxa.`,
          ),
          p('No dates: branch lengths are not available, so the rings are not time.'),
          p('Large fans are polytomies, where relationships are unresolved.'),
        ),
        section(
          'Species details',
          p(link('https://www.wikidata.org/', 'Wikidata'), ' (CC0): taxon items, images, conservation status, Wikipedia titles.'),
          p(link('https://en.wikipedia.org/', 'Wikipedia'), ' (CC BY-SA 4.0): article summaries, linked from each panel.'),
          p(
            'Images from ',
            link('https://commons.wikimedia.org/', 'Wikimedia Commons'),
            ' and ',
            link('https://www.inaturalist.org/', 'iNaturalist'),
            ', under the licence shown with each image. iNaturalist photos only under CC0, CC BY, CC BY-SA or CC BY-NC.',
          ),
          p(
            'Occurrence data © ',
            link('https://www.gbif.org/', 'GBIF.org'),
            ' contributors (CC BY 4.0). Map tiles: GBIF; base map © ',
            link('https://openmaptiles.org/', 'OpenMapTiles'),
            ' © ',
            link('https://www.openstreetmap.org/copyright', 'OpenStreetMap'),
            ' contributors.',
          ),
          p('Conservation status: IUCN Red List categories, via Wikidata or GBIF.'),
        ),
        section(
          'Inspiration',
          p(
            'The “Circle of Life” visualisation popularised from Hinchliff et al. 2015, as covered in Scientific American’s ',
            '“All 2.3 Million Species Are Mapped into a Single Circle of Life”',
            '.',
          ),
        ),
      ]),
    ]);
    this.dialog.setAttribute('aria-labelledby', 'credits-title');
    this.dialog.querySelector('.credits-title')?.setAttribute('id', 'credits-title');
    // A click on the backdrop (outside the dialog's box) closes it.
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    document.body.append(this.dialog);
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
  }

  isOpen(): boolean {
    return this.dialog.open;
  }
}

/** "i" in a circle, 1 px strokes on the 16 px grid the other icons use. */
const INFO_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1"/>' +
  '<path d="M8 7v4.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<circle cx="8" cy="4.9" r="0.75" fill="currentColor"/></svg>';

/**
 * The "i" button (DESIGN.md §4.1): a 40 px glass square in the top row,
 * just before the search bar, that opens Data & credits.
 */
export function mountInfoButton(before: HTMLElement, credits: Credits): HTMLButtonElement {
  const b = el('button', 'info-button');
  b.type = 'button';
  b.title = 'Data & credits';
  b.setAttribute('aria-label', 'Data & credits');
  b.innerHTML = INFO_ICON;
  b.addEventListener('click', () => {
    track('credits');
    credits.open();
  });
  before.before(b);
  return b;
}
