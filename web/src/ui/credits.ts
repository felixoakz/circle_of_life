// "Data & credits" (DESIGN.md §7, docs/data-sources.md §3): every source,
// licence and citation in one dialog, opened from the wordmark menu
// (DESIGN.md §4.1) and from the panel footer.
//
// A native <dialog> opened with showModal(): it traps focus, closes on Esc,
// and gives focus back to whatever opened it. Opaque surface, hairline
// border, no blur; the backdrop is a flat dim.

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

    this.dialog = el('dialog', 'credits', [
      el('div', 'credits-head', [el('h2', 'credits-title', ['Data & credits']), close]),
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
          'Notes',
          p(
            `${nf.format(meta.tipCount)} tips, of which ${nf.format(meta.speciesCount)} are species-rank. ` +
              `The other ${nf.format(otherTips)} are subspecies, varieties and unranked terminal taxa.`,
          ),
          p('No dates: branch lengths are not available, so the rings are not time.'),
          p('Large fans are polytomies, where relationships are unresolved.'),
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

/**
 * The wordmark becomes a menu button (DESIGN.md §4.1): a text-row menu,
 * for now with "Data & credits" (keyboard help and the auto-orient toggle
 * join it later).
 */
export function mountWordmarkMenu(wordmark: HTMLElement, credits: Credits): void {
  const label = wordmark.textContent ?? 'Circle of Life';
  const button = el('button', 'wordmark-button', [label]);
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const item = el('button', 'menu-item', ['Data & credits']);
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  const menu = el('div', 'wordmark-menu', [item]);
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  wordmark.replaceChildren(button);
  wordmark.after(menu);

  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => {
    setOpen(menu.hidden !== false);
    if (!menu.hidden) item.focus();
  });
  item.addEventListener('click', () => {
    setOpen(false);
    credits.open();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      button.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && e.target instanceof Node && !menu.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
}
