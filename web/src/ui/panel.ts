// The node panel, core section (DESIGN.md §4.1–4.3, PLAN §7.10). Desktop:
// a 380 px panel on the right. Below 720 px: a bottom sheet with three snap
// points (peek: the title only; half; full) and a drag handle.
//
// Core content comes straight from /api/nodes: the name (names.ts runs),
// rank and the clade it sits in, for an unnamed node "Unnamed clade, within
// X" and the two taxa it is the common ancestor of; lineage (clickable),
// counts with "relationships unresolved" for polytomies, the largest
// children (clickable), and the OTT / GBIF / NCBI ids as links. The about
// section (image, text, status, map; ui/about.ts) loads after the core from
// /api/nodes/{ref}/about into `.panel-about`, and adds the authority and
// common names to the head, a "Links" row to the facts and the per-source
// credits to the footer. Unnamed (mrca) nodes have no about section.
//
// The panel is an obstacle (ui/obstacles.ts): labels keep clear of it. It
// is opaque, so the tree is not darkened behind it.

import { type NameRun, isPlaceholderName, nameRuns, nameSpans } from '../names';
import type { About, ChildEntry, LineageEntry, NodeInfo } from '../types';
import { aboutError, aboutLoading, aboutView } from './about';
import { segments } from './hud';
import type { Obstacles } from './obstacles';
import { elementBox } from './obstacles';

const nf = new Intl.NumberFormat('en');
/** Children listed before "Show all". */
const CHILDREN_SHOWN = 8;
/** Below this width the panel is a bottom sheet (DESIGN.md §4.3). */
const MOBILE_MAX = 719;
/** Sheet snap heights as fractions of the window (DESIGN.md §4.3: 35% and 85%). */
const SHEET_HALF = 0.35;
const SHEET_FULL = 0.85;
/** A flick faster than this (px/ms) moves one snap in its direction. */
const FLICK = 0.5;

export type Snap = 'peek' | 'half' | 'full';

/**
 * Ranks at or below genus: never "the clade it is in" (the genus is part of
 * a species' name already). The same list as the search context line
 * (`AT_OR_BELOW_GENUS` in src/db/queries.rs).
 */
const AT_OR_BELOW_GENUS = new Set([
  'genus', 'subgenus', 'section', 'subsection', 'series', 'species group', 'species subgroup',
  'species', 'subspecies', 'variety', 'varietas', 'subvariety', 'forma', 'form', 'subform',
  'infraspecificname',
]);

/** A rank as a plain word, or null for "no rank" (DESIGN.md §3). */
export function rankWord(rank: string | null): string | null {
  return rank && !rank.startsWith('no rank') ? rank : null;
}

/** The root ("cellular organisms") reads as Life, as in the breadcrumb. */
function displayName(e: { id: number; name: string | null }): string | null {
  return e.id === 0 ? 'Life' : e.name;
}

/**
 * The clade a node is "in": its nearest named ancestor above genus, named
 * "no rank" clades included (Homo sapiens → Homininae, not Mammalia; OTT
 * leaves Primates unranked and has no Hominidae node). This is the rule of
 * the search results' context line, so both name the same clade. Without
 * one, the nearest named ancestor (the root reads as Life).
 */
export function contextAncestor(node: NodeInfo): LineageEntry | null {
  for (let i = node.lineage.length - 1; i >= 0; i--) {
    const a = node.lineage[i];
    if (!a?.name || a.id === 0 || isPlaceholderName(a.name)) continue;
    if (!AT_OR_BELOW_GENUS.has(a.rank ?? '')) return a;
  }
  for (let i = node.lineage.length - 1; i >= 0; i--) {
    const a = node.lineage[i];
    if (a && (a.id === 0 || (a.name && !isPlaceholderName(a.name)))) return a;
  }
  return null;
}

/** "1 species · 0 direct descendants", "412 direct descendants · relationships unresolved". */
export function countsLine(node: NodeInfo): string {
  const kids = node.children.total;
  const parts = [
    `${nf.format(node.leafCount)} species`,
    `${nf.format(kids)} direct ${kids === 1 ? 'descendant' : 'descendants'}`,
  ];
  // More than two children is a polytomy: synth could not resolve them (PLAN §5.1).
  if (kids > 2) parts.push('relationships unresolved');
  return parts.join(' · ');
}

/** The two OTT ids an mrca node is named after (`mrcaott42ott4130`), or null. */
export function mrcaPair(nodeId: string): [string, string] | null {
  const m = /^mrca(ott\d+)(ott\d+)$/.exec(nodeId);
  return m && m[1] && m[2] ? [m[1], m[2]] : null;
}

/** The sheet snap nearest a visible height, nudged one step by a flick (velocity px/ms, + = up). */
export function nearestSnap(visible: number, velocity: number, heights: Record<Snap, number>): Snap {
  const order: Snap[] = ['peek', 'half', 'full'];
  let best: Snap = 'peek';
  for (const s of order) if (Math.abs(heights[s] - visible) < Math.abs(heights[best] - visible)) best = s;
  if (Math.abs(velocity) > FLICK) {
    // A flick goes to the next snap in its direction from where the drag is.
    const above = order.filter((s) => heights[s] > visible + 1);
    const below = order.filter((s) => heights[s] < visible - 1);
    if (velocity > 0 && above[0]) return above[0];
    if (velocity < 0 && below.length > 0) return below[below.length - 1] ?? best;
  }
  return best;
}

type Props = { className?: string; text?: string; title?: string; label?: string };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  if (props.label) e.setAttribute('aria-label', props.label);
  e.append(...children);
  return e;
}

function link(href: string, children: (Node | string)[], label?: string): HTMLAnchorElement {
  const a = el('a', { label }, children);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function nameNodes(runs: readonly NameRun[]): HTMLSpanElement[] {
  return nameSpans(runs);
}

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>';

export interface PanelHooks {
  /** A lineage entry or child was clicked. */
  select: (id: number) => void;
  /** The close button (or Esc, handled by selection.ts). */
  close: () => void;
  /** Names of the taxa an mrca node is the common ancestor of. */
  node: (ref: string) => Promise<NodeInfo>;
  /** The panel's size or position changed (the camera keeps the selection in view). */
  moved: () => void;
  /** The enrichment document (`retry` refetches a partial one). */
  about: (ref: string, retry: boolean, signal: AbortSignal) => Promise<About>;
  /** Opens the Data & credits dialog. */
  credits: () => void;
}

/** If an image or map tile never answers, the panel stops counting as busy after this. */
const SETTLE_TIMEOUT_MS = 20_000;

/** The parts of the rendered panel the about section adds to. */
interface Slots {
  head: HTMLElement;
  about: HTMLElement;
  facts: HTMLElement;
  credit: HTMLElement;
}

export class Panel {
  readonly root: HTMLElement;
  private readonly hooks: PanelHooks;
  private readonly obstacles: Obstacles;
  private readonly dataVersion: string;
  private readonly handle: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly body: HTMLElement;
  private shown: NodeInfo | null = null;
  private open = false;
  private snap: Snap = 'half';
  private pendingMrca = 0;
  /** About requests, images and map tiles still loading (screenshots wait for them). */
  private pendingAbout = 0;
  private aboutCtl: AbortController | null = null;
  private slots: Slots | null = null;
  private hideTimer = 0;
  private returnFocus: Element | null = null;
  reducedMotion = false;

  constructor(root: HTMLElement, obstacles: Obstacles, dataVersion: string, hooks: PanelHooks) {
    this.root = root;
    this.obstacles = obstacles;
    this.dataVersion = dataVersion;
    this.hooks = hooks;
    root.setAttribute('aria-labelledby', 'panel-title');
    this.handle = el('button', { className: 'sheet-handle', label: 'Resize the details sheet' });
    this.handle.type = 'button';
    this.handle.append(el('span', { className: 'sheet-bar' }));
    this.progress = el('div', { className: 'panel-progress' });
    this.progress.setAttribute('aria-hidden', 'true');
    this.body = el('div', { className: 'panel-body' });
    root.replaceChildren(this.handle, this.progress, this.body);
    obstacles.set('panel', () => {
      const box = this.open ? elementBox(this.root) : null;
      return box ? [{ box, keepClear: true, toEdge: false, dim: 0 }] : [];
    });
    this.bindSheet();
    window.addEventListener('resize', () => {
      if (this.open) this.applySnap(false);
    });
    root.addEventListener('transitionend', () => this.obstacles.changed());
  }

  isOpen(): boolean {
    return this.open;
  }

  /** True while the panel waits for data (the scene is not idle for screenshots). */
  busy(): boolean {
    return this.pendingMrca > 0 || this.pendingAbout > 0;
  }

  /** Below 720 px the panel is a bottom sheet. */
  isSheet(): boolean {
    return window.innerWidth <= MOBILE_MAX;
  }

  /**
   * The screen area the panel covers when open, CSS px: its width on the
   * right (desktop), or the sheet's height at its open snap at the bottom.
   */
  inset(): { right: number; bottom: number } {
    if (this.isSheet()) return { right: 0, bottom: this.heights().half };
    const r = this.root.getBoundingClientRect();
    return { right: r.width > 0 ? window.innerWidth - r.left : 0, bottom: 0 };
  }

  /** Shows a hairline loading line while the next node is fetched. */
  loading(on: boolean): void {
    this.progress.classList.toggle('on', on);
  }

  /**
   * Fills the panel with `node` and opens it. `focus` moves keyboard focus
   * to the title when it opens (a user's selection, not a deep link loading).
   */
  show(node: NodeInfo, focus: boolean): void {
    const opening = !this.open;
    const hadFocus = this.root.contains(document.activeElement);
    this.shown = node;
    this.render(node);
    window.clearTimeout(this.hideTimer);
    if (opening) {
      this.returnFocus = document.activeElement;
      this.root.hidden = false;
      this.open = true;
      this.snap = 'half';
      // Next frame, so the transition runs from the closed state.
      requestAnimationFrame(() => {
        this.root.classList.add('open');
        this.applySnap(true);
      });
    }
    if (focus && (opening || hadFocus)) {
      // Keyboard and screen-reader users land on the title (DESIGN.md §8).
      this.root.querySelector<HTMLElement>('#panel-title')?.focus({ preventScroll: true });
    }
    if (!opening) {
      this.body.scrollTop = 0;
    }
    this.obstacles.changed();
  }

  /** Shows an error in place of the content (DESIGN.md §7: specific copy). */
  showError(retry: () => void): void {
    const again = el('button', { className: 'text-button', text: 'Retry' });
    again.type = 'button';
    again.addEventListener('click', retry);
    this.body.replaceChildren(
      this.header(el('h2', { className: 'panel-title', text: 'Taxon unavailable' })),
      el('p', { className: 'panel-error' }, ['Couldn’t load this taxon. ', again]),
    );
    if (!this.open) {
      this.root.hidden = false;
      this.open = true;
      requestAnimationFrame(() => {
        this.root.classList.add('open');
        this.applySnap(true);
      });
    }
    this.obstacles.changed();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.shown = null;
    this.aboutCtl?.abort();
    this.aboutCtl = null;
    this.root.classList.remove('open');
    document.documentElement.style.setProperty('--sheet-h', '0px');
    this.root.style.removeProperty('--sheet-visible');
    const done = (): void => {
      if (!this.open) this.root.hidden = true;
    };
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(done, this.reducedMotion ? 0 : 240);
    // Focus goes back where it was, if that is still on the page.
    const back = this.returnFocus;
    this.returnFocus = null;
    if (this.root.contains(document.activeElement)) {
      if (back instanceof HTMLElement && back.isConnected && !this.root.contains(back)) back.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    }
    this.obstacles.changed();
    this.hooks.moved();
  }

  private header(title: HTMLElement): HTMLElement {
    const close = el('button', { className: 'ctl panel-close', label: 'Close details', title: 'Close (Esc)' });
    close.type = 'button';
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => this.hooks.close());
    title.id = 'panel-title';
    title.tabIndex = -1;
    return el('header', { className: 'panel-head' }, [el('div', { className: 'panel-title-row' }, [title, close])]);
  }

  private render(n: NodeInfo): void {
    const named = n.name !== null && n.name !== '';
    const rank = rankWord(n.rank);
    // Title: the name in its own style (serif italic only for genus and below).
    const title = el('h2', { className: 'panel-title' });
    if (named) title.append(...nameNodes(nameRuns(n.name ?? '', n.rank)));
    else title.textContent = 'Unnamed clade';
    const copy = el('button', { className: 'text-button copy', title: 'Copy the name', label: 'Copy the name' }, ['⧉']);
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(n.name ?? n.nodeId).then(
        () => (copy.title = 'Copied'),
        () => (copy.title = 'Copy failed'),
      );
    });
    if (named) title.append(' ', copy);
    const head = this.header(title);

    // "species · in Felidae", or for an unnamed node "within Felidae".
    const ctx = el('p', { className: 'panel-context' });
    const anc = named ? contextAncestor(n) : n.namedAncestor;
    const ancName = anc ? displayName(anc) : null;
    const parts: (Node | string)[] = [];
    if (named && rank) parts.push(rank);
    if (ancName && anc) {
      if (parts.length > 0) parts.push(' · ');
      parts.push(named ? 'in ' : 'within ', ...nameNodes(nameRuns(ancName, anc.rank)));
    }
    ctx.append(...parts);
    if (parts.length > 0) head.append(ctx);

    // The GBIF common name from tree.db (P11) shows at once; the about
    // section's own list replaces it once it loads, if it has one.
    if (named && n.commonName) {
      head.append(el('p', { className: 'panel-context common-fallback', text: `Common name: ${n.commonName}` }));
    }

    // An mrca node is the common ancestor of the two taxa in its id.
    if (!named) {
      const mrca = el('p', { className: 'panel-context panel-mrca' });
      head.append(mrca);
      void this.fillMrca(n, mrca);
    }

    // Filled by loadAbout (image, text, status, map); hidden for unnamed nodes.
    const about = el('section', { className: 'panel-about', label: 'About' });
    about.dataset.slot = 'about';
    about.hidden = true;

    const facts = el('dl', { className: 'panel-facts' });
    const row = (label: string, value: Node | null): void => {
      if (!value) return;
      facts.append(el('dt', { text: label }), el('dd', {}, [value]));
    };
    row('Lineage', this.lineage(n));
    row('Counts', el('span', { className: 'tabular', text: countsLine(n) }));
    row(n.children.total === 1 ? 'Child' : 'Children', this.children(n));
    row('IDs', this.ids(n));

    const credit = el('p', { className: 'panel-credit' });
    this.slots = { head, about, facts, credit };
    this.fillCredit([]);

    this.body.replaceChildren(head, about, facts, credit);
    if (named) void this.loadAbout(n, false);
  }

  /** The footer: per-source credits, the tree, and the Data & credits dialog. */
  private fillCredit(parts: (Node | string)[][]): void {
    const credit = this.slots?.credit;
    if (!credit) return;
    const all: (Node | string)[][] = [
      ...parts,
      ['Tree: ', link('https://tree.opentreeoflife.org/about/synthesis-release', ['Open Tree of Life']), ` ${this.synthVersion()} (CC0)`],
    ];
    const dialog = el('button', { className: 'text-button credits-link', text: 'Data & credits' });
    dialog.type = 'button';
    dialog.addEventListener('click', () => this.hooks.credits());
    credit.replaceChildren();
    for (const part of all) credit.append(...part, ' · ');
    credit.append(dialog);
  }

  /** Fetches and shows the about section for `n` (DESIGN.md §7 loading, missing and error copy). */
  private async loadAbout(n: NodeInfo, retry: boolean): Promise<void> {
    const slots = this.slots;
    if (!slots) return;
    this.aboutCtl?.abort();
    const ctl = new AbortController();
    this.aboutCtl = ctl;
    slots.about.hidden = false;
    slots.about.classList.add('loading');
    slots.about.replaceChildren(aboutLoading());
    // Busy until the request, the image and the map tiles have all
    // answered (or SETTLE_TIMEOUT_MS passed): screenshots wait for this.
    this.pendingAbout++;
    let open = 1; // the request itself; the image and the map add theirs
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      this.pendingAbout--;
      this.hooks.moved();
    };
    const settle = (): void => {
      open--;
      if (open <= 0) finish();
    };
    const timer = window.setTimeout(finish, SETTLE_TIMEOUT_MS);
    try {
      const doc = await this.hooks.about(n.nodeId, retry, ctl.signal);
      if (ctl.signal.aborted || this.shown !== n) return;
      const width = slots.about.clientWidth || 346;
      const view = aboutView(doc, n, width, {
        retry: () => void this.loadAbout(n, true),
        credits: () => this.hooks.credits(),
        settled: settle,
      });
      if (view.map) open++;
      slots.about.classList.remove('loading');
      slots.about.replaceChildren(...view.section);
      for (const old of slots.head.querySelectorAll('.about-head')) old.remove();
      if (doc.commonNames.length > 0) for (const old of slots.head.querySelectorAll('.common-fallback')) old.remove();
      for (const line of view.head) {
        line.classList.add('about-head');
        slots.head.append(line);
      }
      for (const old of slots.facts.querySelectorAll('.about-links-row')) old.remove();
      if (view.links) {
        const dt = el('dt', { className: 'about-links-row', text: 'Links' });
        const dd = el('dd', { className: 'about-links-row' }, [view.links]);
        slots.facts.append(dt, dd);
      }
      this.fillCredit(view.credits);
      const img = slots.about.querySelector<HTMLImageElement>('.about-image');
      if (img && !img.complete) {
        open++;
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
      }
      this.obstacles.changed();
    } catch (err) {
      if (ctl.signal.aborted || this.shown !== n) return;
      console.warn('about', err);
      slots.about.classList.remove('loading');
      slots.about.replaceChildren(aboutError(() => void this.loadAbout(n, true)));
    } finally {
      // Replaced or closed: stop counting this one at once.
      if (ctl.signal.aborted) finish();
      else settle();
      if (this.aboutCtl === ctl) this.aboutCtl = null;
    }
  }

  /** "16.1" from the data version, for the credit line and Open Tree links. */
  private synthVersion(): string {
    return /^otl([\d.]+)/.exec(this.dataVersion)?.[1] ?? '';
  }

  /** Lineage, root first, as clickable names (placeholders and unnamed nodes skipped). */
  private lineage(n: NodeInfo): HTMLElement | null {
    const segs = segments(n).filter((s) => s.id !== n.id);
    if (segs.length === 0) return null;
    const ol = el('ol', { className: 'panel-lineage', label: 'Lineage' });
    for (const s of segs) {
      const b = el('button', { className: 'text-button', title: `Select ${s.name}` }, nameNodes(s.runs));
      b.type = 'button';
      b.addEventListener('click', () => this.hooks.select(s.id));
      // A real space between items is where lines may break.
      ol.append(el('li', {}, [b]), ' ');
    }
    return ol;
  }

  /** The largest children, by species count, clickable. */
  private children(n: NodeInfo): HTMLElement | null {
    const top = n.children.top;
    if (top.length === 0) return null;
    const wrap = el('div');
    const ul = el('ul', { className: 'panel-children' });
    const item = (c: ChildEntry): HTMLLIElement => {
      const name = c.name && c.name !== '' ? nameNodes(nameRuns(c.name, c.rank)) : [el('span', { className: 'unnamed', text: 'Unnamed clade' })];
      const b = el('button', { className: 'child-row' }, [
        el('span', { className: 'child-name' }, name),
        el('span', { className: 'child-count tabular', text: nf.format(c.leafCount) }),
      ]);
      b.type = 'button';
      b.title = `Select ${c.name ?? 'this clade'} (${nf.format(c.leafCount)} species)`;
      b.addEventListener('click', () => this.hooks.select(c.id));
      return el('li', {}, [b]);
    };
    for (const c of top.slice(0, CHILDREN_SHOWN)) ul.append(item(c));
    wrap.append(ul);
    const rest = top.slice(CHILDREN_SHOWN);
    if (rest.length > 0) {
      const more = el('button', {
        className: 'text-button more',
        text: `Show ${nf.format(rest.length)} more`,
      });
      more.type = 'button';
      more.addEventListener('click', () => {
        for (const c of rest) ul.append(item(c));
        more.remove();
        this.obstacles.changed();
      });
      wrap.append(more);
    }
    if (n.children.total > top.length) {
      wrap.append(
        el('p', {
          className: 'panel-note',
          text: `The ${nf.format(top.length)} largest of ${nf.format(n.children.total)}.`,
        }),
      );
    }
    return wrap;
  }

  /** OTT, GBIF and NCBI ids in mono, each a link to its source (an mrca node links to Open Tree). */
  private ids(n: NodeInfo): HTMLElement {
    const span = el('span', { className: 'id' });
    const add = (label: string, id: string, href: string): void => {
      if (span.childNodes.length > 0) span.append(' · ');
      span.append(link(href, [`${label} ${id}`], `${label} ${id}`));
    };
    if (n.ids.ott !== null) add('OTT', String(n.ids.ott), `https://tree.opentreeoflife.org/taxonomy/browse?id=${n.ids.ott}`);
    else add('Open Tree', n.nodeId, `https://tree.opentreeoflife.org/opentree/argus/opentree${this.synthVersion()}@${n.nodeId}`);
    if (n.ids.gbif !== null) add('GBIF', String(n.ids.gbif), `https://www.gbif.org/species/${n.ids.gbif}`);
    if (n.ids.ncbi !== null) {
      add('NCBI', String(n.ids.ncbi), `https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${n.ids.ncbi}`);
    }
    return span;
  }

  /**
   * "Common ancestor of A and B": the two taxa the mrca id names, or, when
   * either is missing from the tree, its two largest named children (any
   * two children lie in different subtrees, so this node is their common
   * ancestor too).
   */
  private async fillMrca(n: NodeInfo, out: HTMLElement): Promise<void> {
    this.pendingMrca++;
    try {
      let pair: { name: string; rank: string | null }[] = [];
      const ids = mrcaPair(n.nodeId);
      if (ids) {
        try {
          const [a, b] = await Promise.all(ids.map((id) => this.hooks.node(id)));
          if (a?.name && b?.name) pair = [a, b].map((x) => ({ name: x.name ?? '', rank: x.rank }));
        } catch {
          // One of them is not in the tree: fall back to the children.
        }
      }
      if (pair.length < 2) {
        pair = n.children.top
          .filter((c) => c.name && !isPlaceholderName(c.name))
          .slice(0, 2)
          .map((c) => ({ name: c.name ?? '', rank: c.rank }));
      }
      const [a, b] = pair;
      if (!a || !b || this.shown !== n) return;
      out.replaceChildren(
        'Common ancestor of ',
        ...nameNodes(nameRuns(a.name, a.rank)),
        ' and ',
        ...nameNodes(nameRuns(b.name, b.rank)),
      );
      this.obstacles.changed();
    } finally {
      this.pendingMrca--;
    }
  }

  // ---- Bottom sheet (mobile) ----

  private heights(): Record<Snap, number> {
    const h = window.innerHeight;
    const head = this.root.querySelector('.panel-head')?.getBoundingClientRect().height ?? 72;
    const handle = this.handle.getBoundingClientRect().height || 40;
    return { peek: Math.round(handle + head + 8), half: Math.round(h * SHEET_HALF), full: Math.round(h * SHEET_FULL) };
  }

  /** Moves the sheet to its snap (no-op on desktop) and tells the HUD how much is covered. */
  private applySnap(notify: boolean): void {
    if (!this.isSheet()) {
      document.documentElement.style.setProperty('--sheet-h', '0px');
      this.root.style.removeProperty('--sheet-visible');
      if (notify) this.hooks.moved();
      return;
    }
    const visible = this.heights()[this.snap];
    this.setVisible(visible);
    this.handle.setAttribute('aria-expanded', String(this.snap === 'full'));
    if (notify) this.hooks.moved();
  }

  private setVisible(px: number): void {
    this.root.style.setProperty('--sheet-visible', `${px}px`);
    document.documentElement.style.setProperty('--sheet-h', `${px}px`);
    this.obstacles.changed();
  }

  setSnap(s: Snap): void {
    this.snap = s;
    this.applySnap(true);
  }

  /** Drag the handle (or the header) to resize; tap the handle to step half ↔ full. */
  private bindSheet(): void {
    let drag: { y: number; start: number; lastY: number; lastT: number; v: number; moved: boolean } | null = null;
    const start = (e: PointerEvent): void => {
      if (!this.isSheet() || !this.open) return;
      if (e.target instanceof Element && e.target.closest('button:not(.sheet-handle), a')) return;
      const visible = this.heights()[this.snap];
      drag = { y: e.clientY, start: visible, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
      this.root.classList.add('dragging-sheet');
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      const h = this.heights();
      const visible = Math.min(h.full, Math.max(h.peek, drag.start - dy));
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag.v = 0.6 * ((drag.lastY - e.clientY) / dt) + 0.4 * drag.v;
      drag.lastY = e.clientY;
      drag.lastT = e.timeStamp;
      this.setVisible(visible);
    };
    const end = (e: PointerEvent): void => {
      if (!drag) return;
      const d = drag;
      drag = null;
      this.root.classList.remove('dragging-sheet');
      if (!d.moved) {
        if (e.currentTarget === this.handle) this.setSnap(this.snap === 'full' ? 'half' : 'full');
        else this.applySnap(false);
        return;
      }
      const visible = d.start - (e.clientY - d.y);
      this.setSnap(nearestSnap(visible, d.v, this.heights()));
    };
    for (const target of [this.handle, this.root]) {
      target.addEventListener('pointerdown', (e) => {
        if (target === this.root && !(e.target instanceof Element && e.target.closest('.panel-head'))) return;
        if (target === this.root && e.target instanceof Element && e.target.closest('.sheet-handle')) return;
        start(e);
      });
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    }
    // Keyboard: the handle is a button; Enter or Space steps between half and full.
    this.handle.addEventListener('click', (e) => {
      if (e.detail === 0) this.setSnap(this.snap === 'full' ? 'half' : 'full');
    });
  }
}
