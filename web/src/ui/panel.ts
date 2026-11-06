// The selection card (DESIGN.md §4.1–4.3, ARCHITECTURE §7.10): a fixed rectangle,
// top right on desktop and across the top on a phone, its place set by the
// layout (layout.ts, `place`). There is always a selection, so the card
// never closes. Nothing in it scrolls: under its head it has tabs
// (ui/tabs.ts), and each tab's content is fitted to the tab area (ui/fit.ts).
// A leader joins the card to the selected node (callout.ts).
//
// The head is always there: the name (names.ts runs) with a copy button,
// the common name, rank and the clade it sits in (and the authority once
// /about is in), "You are here" for Homo sapiens; for an unnamed node
// "Unnamed clade, within X" and the two taxa it is the common ancestor of.
//
// Tabs: Overview (image, extract, status; ui/about.ts), Range (GBIF map,
// records, top countries) and Tree (lineage, counts, children, ids, links,
// credits), the first two from /api/nodes/{ref}/about. A tab with nothing to
// show is left out: an unnamed node has Tree only, most clades no Range.
// The tab the visitor picks is kept for the next selection that has it.
//
// The card is an obstacle (ui/obstacles.ts): labels keep clear of it. It
// is opaque, so the tree is not darkened behind it.

import type { Box } from '../labelLayout';
import { type NameRun, isPlaceholderName, nameRuns, nameSpans } from '../names';
import type { About, ChildEntry, LineageEntry, NodeInfo } from '../types';
import { wait } from '../wait';
import { aboutError, aboutLoading, aboutView, sentenceCase } from './about';
import { clipBlocks, dropUntilFits, fitExtracts, overflows, unfit } from './fit';
import { segments } from './hud';
import type { Obstacles } from './obstacles';
import { elementBox } from './obstacles';
import { type TabId, Tabs, tabToShow } from './tabs';

const nf = new Intl.NumberFormat('en');
/** The Tree tab's lineage takes at most this many lines (the nearest ancestors). */
const LINEAGE_LINES = 2;

/**
 * Ranks at or below genus: never "the clade it is in" (the genus is part of
 * a species' name already). The same list as the search context line
 * (`atOrBelowGenus` in internal/db/search.go).
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

/** "i" in a circle, 1 px strokes on the 16 px grid the other icons use. */
const INFO_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1"/>' +
  '<path d="M8 7v4.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<circle cx="8" cy="4.9" r="0.75" fill="currentColor"/></svg>';

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

/**
 * "1 species · 0 direct descendants", "412 species · 412 direct descendants ·
 * relationships unresolved"; a species with subspecies: "7 subspecies".
 */
function countsLine(node: NodeInfo): string {
  const kids = node.children.total;
  if (node.rank === 'species' && kids > 0) return `${nf.format(node.leafCount)} subspecies`;
  const parts = [
    `${nf.format(node.leafCount)} species`,
    `${nf.format(kids)} direct ${kids === 1 ? 'descendant' : 'descendants'}`,
  ];
  // More than two children is a polytomy: synth could not resolve them (ARCHITECTURE §5.1).
  if (kids > 2) parts.push('relationships unresolved');
  return parts.join(' · ');
}

/** The two OTT ids an mrca node is named after (`mrcaott42ott4130`), or null. */
function mrcaPair(nodeId: string): [string, string] | null {
  const m = /^mrca(ott\d+)(ott\d+)$/.exec(nodeId);
  return m && m[1] && m[2] ? [m[1], m[2]] : null;
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

export interface PanelHooks {
  /** A lineage entry or child was clicked. */
  select: (id: number) => void;
  /** Names of the taxa an mrca node is the common ancestor of. */
  node: (ref: string) => Promise<NodeInfo>;
  /** The card's content changed size (labels re-layout around it). */
  moved: () => void;
  /** The enrichment document (`retry` refetches a partial one). */
  about: (ref: string, retry: boolean, signal: AbortSignal) => Promise<About>;
  /** Opens the Data & credits dialog. */
  credits: () => void;
  /** True for the "You are here" node (Homo sapiens), which says so in its head. */
  home: (n: NodeInfo) => boolean;
}

/** If an image or map tile never answers, the panel stops counting as busy after this. */
const SETTLE_TIMEOUT_MS = 20_000;
/** A selection must stay this long before the card asks for its /about (wait.ts), ms. */
export const ABOUT_SETTLE_MS = 500;
/** After a Retry click, Retry buttons stay disabled this long, ms. */
const RETRY_HOLD_MS = 5000;
/** Children listed at most at once in the Tree tab (fewer when they do not fit). */
const CHILDREN_MAX = 8;

/** Ranks with a range map worth a tab while /about loads (species and below; tips too). */
function rangeLikely(n: NodeInfo): boolean {
  return n.childCount === 0 || AT_OR_BELOW_GENUS.has(n.rank ?? '') && n.rank !== 'genus';
}

/** The parts of the rendered card the about section adds to. */
interface Slots {
  head: HTMLElement;
  facts: HTMLElement;
  credit: HTMLElement;
}

export class Panel {
  readonly root: HTMLElement;
  private readonly hooks: PanelHooks;
  private readonly obstacles: Obstacles;
  private readonly dataVersion: string;
  private readonly progress: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs = new Tabs();
  /** The tab the visitor last picked: kept across selections when the next node has it. */
  private preferred: TabId = 'overview';
  /** Fits each tab's content to the tab area (ui/fit.ts), set as the tab is filled. */
  private readonly fitters = new Map<TabId, () => void>();
  private shown: NodeInfo | null = null;
  private open = false;
  private pendingMrca = 0;
  /** About requests, images and map tiles still loading (screenshots wait for them). */
  private pendingAbout = 0;
  private aboutCtl: AbortController | null = null;
  /** performance.now() of the last Retry click. */
  private retryAt = -Infinity;
  private slots: Slots | null = null;
  private compact = false;

  constructor(root: HTMLElement, obstacles: Obstacles, dataVersion: string, hooks: PanelHooks) {
    this.root = root;
    this.obstacles = obstacles;
    this.dataVersion = dataVersion;
    this.hooks = hooks;
    root.setAttribute('aria-labelledby', 'panel-title');
    this.progress = el('div', { className: 'panel-progress' });
    this.progress.setAttribute('aria-hidden', 'true');
    this.body = el('div', { className: 'panel-body' });
    root.replaceChildren(this.progress, this.body);
    this.tabs.onPick = (id) => (this.preferred = id);
    this.tabs.onShow = (id) => this.fit(id);
    obstacles.set('panel', () => {
      const box = this.box();
      // Out to the top edge: no label squeezes into the header strip above the card.
      return box ? [{ box, keepClear: true, toEdge: true, dim: 0 }] : [];
    });
    new ResizeObserver(() => {
      this.obstacles.changed();
      this.hooks.moved();
    }).observe(this.root);
    // A new tab area (another window size, a longer head): fit the shown tab again.
    new ResizeObserver(() => {
      const id = this.tabs.active();
      if (id) this.fit(id);
    }).observe(this.tabs.body);
  }

  /**
   * Puts the card at `box`'s left, top and width (CSS px, from layout.ts),
   * `height` tall: a fixed box, whose tabs fit their content to it.
   * `compact` on a phone or portrait window.
   */
  place(box: Box, height: number, compact: boolean): void {
    const st = this.root.style;
    st.left = `${box.x0}px`;
    st.top = `${box.y0}px`;
    st.width = `${box.x1 - box.x0}px`;
    st.height = `${height}px`;
    this.compact = compact;
    this.root.classList.toggle('compact', compact);
    this.obstacles.changed();
  }

  /** The card's box on screen, CSS px, or null before it first shows. */
  box(): Box | null {
    return this.open ? elementBox(this.root) : null;
  }

  /** The tab on show (tests, screenshots). */
  activeTab(): TabId | null {
    return this.tabs.active();
  }

  /** True while the card waits for data (the scene is not idle for screenshots). */
  busy(): boolean {
    return this.pendingMrca > 0 || this.pendingAbout > 0;
  }

  /** Shows a hairline loading line while the next node is fetched. */
  loading(on: boolean): void {
    this.progress.classList.toggle('on', on);
  }

  /**
   * Fills the card with `node`, showing it the first time. `focus` moves
   * keyboard focus to the title when focus was already in the card (a
   * keyboard user walking the lineage or children stays in the card).
   */
  show(node: NodeInfo, focus: boolean, fade = false): void {
    const hadFocus = this.root.contains(document.activeElement);
    this.shown = node;
    this.reveal();
    this.render(node);
    if (fade && this.open) {
      // Restart the 200 ms fade-in (styles.css .swap): a new node's content.
      this.body.classList.remove('swap');
      void this.body.offsetWidth;
      this.body.classList.add('swap');
    }
    if (focus && hadFocus) {
      // Keyboard and screen-reader users land on the title (DESIGN.md §8).
      this.root.querySelector<HTMLElement>('#panel-title')?.focus({ preventScroll: true });
    }
    this.obstacles.changed();
  }

  /** Unhides the card (it starts hidden until the first selection is in) and fades it in. */
  private reveal(): void {
    if (this.open) return;
    this.open = true;
    this.root.hidden = false;
    // Next frame, so the transition runs from the hidden state.
    requestAnimationFrame(() => this.root.classList.add('open'));
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
    this.reveal();
    this.obstacles.changed();
  }

  private header(title: HTMLElement): HTMLElement {
    title.id = 'panel-title';
    title.tabIndex = -1;
    // Data & credits, at the head's right on every card: the only menu there is.
    const info = el('button', { className: 'panel-info', title: 'Data & credits', label: 'Data & credits' });
    info.type = 'button';
    info.innerHTML = INFO_ICON;
    info.addEventListener('click', () => this.hooks.credits());
    return el('header', { className: 'panel-head' }, [el('div', { className: 'panel-title-row' }, [title, info])]);
  }

  /** Fits tab `id`'s content to the tab area, if it is the one on show. */
  private fit(id: TabId): void {
    if (this.tabs.active() !== id) return;
    this.fitters.get(id)?.();
  }

  /** Shows the tabs in `ids`: the visitor's tab if there, else the one on show if still there, else Overview. */
  private setTabs(ids: TabId[]): void {
    const current = this.tabs.active();
    const keep = ids.includes(this.preferred) ? this.preferred : current && ids.includes(current) ? current : null;
    this.tabs.set(ids, keep ?? tabToShow(ids, this.preferred));
  }

  private render(n: NodeInfo): void {
    const named = n.name !== null && n.name !== '';
    const rank = rankWord(n.rank);
    // Title: the name in its own style (serif italic only for genus and below).
    const title = el('h2', { className: 'panel-title' });
    if (named) title.append(...nameNodes(nameRuns(n.name ?? '', n.rank)));
    else title.textContent = 'Unnamed clade';
    const head = this.header(title);
    if (named) {
      // Beside the title, not inside it: the heading reads as the name alone.
      const copy = el('button', { className: 'copy', title: 'Copy the name', label: 'Copy the name' });
      copy.type = 'button';
      // Two offset squares, drawn like the padlock (1 px strokes on a 16 px grid):
      // the ⧉ glyph rendered at text size read as a broken image.
      copy.innerHTML =
        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
        '<rect x="5.5" y="5.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/>' +
        '<path d="M10.5 3.5v-1h-8v8h1" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(n.name ?? n.nodeId).then(
          () => (copy.title = 'Copied'),
          () => (copy.title = 'Copy failed'),
        );
      });
      title.after(copy);
    }

    // The lead: the common name, what most visitors know it by (GBIF's from
    // tree.db at once; the about section's own replaces it once it loads).
    const lead = el('p', { className: 'panel-lead' });
    if (named && n.commonName) lead.textContent = sentenceCase(n.commonName);
    head.append(lead);

    // "species · in Felidae · Linnaeus, 1758", or for an unnamed node "within Felidae".
    const ctx = el('p', { className: 'panel-context panel-meta' });
    const anc = named ? contextAncestor(n) : n.namedAncestor;
    const ancName = anc ? displayName(anc) : null;
    const parts: (Node | string)[] = [];
    if (named && rank) parts.push(rank);
    if (ancName && anc) {
      if (parts.length > 0) parts.push(' · ');
      parts.push(named ? 'in ' : 'within ', ...nameNodes(nameRuns(ancName, anc.rank)));
    }
    ctx.append(...parts);
    head.append(ctx);
    if (this.hooks.home(n)) head.append(el('p', { className: 'panel-context panel-here', text: 'You are here' }));

    // An mrca node is the common ancestor of the two taxa in its id.
    if (!named) {
      const mrca = el('p', { className: 'panel-context panel-mrca' });
      head.append(mrca);
      void this.fillMrca(n, mrca);
    }

    // Tree: lineage, counts, children, ids (and links, once /about is in), credits.
    const tree = this.tabs.panel('tree');
    const facts = el('dl', { className: 'panel-facts' });
    const row = (label: string, value: Node | null, className = ''): HTMLElement | null => {
      if (!value) return null;
      const r = el('div', { className: `fact ${className}`.trim() }, [el('dt', { text: label }), el('dd', {}, [value])]);
      facts.append(r);
      return r;
    };
    const lineage = this.lineage(n);
    row('Lineage', lineage?.node ?? null, 'fact-lineage');
    row('Counts', el('span', { className: 'tabular', text: countsLine(n) }), 'fact-counts');
    const kids = this.children(n);
    row(n.children.total === 1 ? 'Child' : 'Children', kids?.node ?? null, 'fact-children');
    row('IDs', this.ids(n), 'fact-ids');
    const credit = el('p', { className: 'panel-credit' });
    tree.replaceChildren(facts, credit);
    this.slots = { head, facts, credit };
    this.fillCredit([]);
    this.fitters.set('tree', () => {
      unfit(tree);
      lineage?.fit();
      const over = (): boolean => overflows(tree);
      // Children first (down to a few), then the credit line (the tabs
      // credit their own sources), then children down to one, links, ids.
      kids?.fit(over, 4);
      dropUntilFits(tree, [credit]);
      if (credit.hidden) kids?.fit(over, 1);
      dropUntilFits(tree, [facts.querySelector('.fact-links'), facts.querySelector('.fact-ids')]);
      clipBlocks(facts, tree);
    });

    // Overview and Range wait for /about; unnamed (mrca) nodes have neither.
    const overview = this.tabs.panel('overview');
    const range = this.tabs.panel('range');
    overview.replaceChildren();
    range.replaceChildren();
    this.fitters.delete('overview');
    this.fitters.delete('range');
    this.body.replaceChildren(head, this.tabs.list, this.tabs.body);
    if (!named) {
      this.aboutCtl?.abort();
      this.setTabs(['tree']);
      return;
    }
    overview.append(aboutLoading());
    const ids: TabId[] = ['overview', 'tree'];
    if (rangeLikely(n)) {
      range.append(aboutLoading('Fetching from GBIF…'));
      ids.splice(1, 0, 'range');
    }
    this.setTabs(ids);
    void this.loadAbout(n, false);
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

  /** Fetches and shows the about tabs for `n` (DESIGN.md §7 loading, missing and error copy, inside each tab). */
  private async loadAbout(n: NodeInfo, retry: boolean): Promise<void> {
    const slots = this.slots;
    if (!slots) return;
    this.aboutCtl?.abort();
    const ctl = new AbortController();
    this.aboutCtl = ctl;
    const overview = this.tabs.panel('overview');
    const range = this.tabs.panel('range');
    if (retry) {
      overview.replaceChildren(aboutLoading());
      if (this.tabs.shown().includes('range')) range.replaceChildren(aboutLoading('Fetching from GBIF…'));
    }
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
      // The loading line shows meanwhile; a newer selection aborts ctl and
      // this one never asks. A Retry click asks at once.
      if (!retry && !(await wait(ABOUT_SETTLE_MS, ctl.signal))) return;
      const doc = await this.hooks.about(n.nodeId, retry, ctl.signal);
      if (ctl.signal.aborted || this.shown !== n) return;
      const area = { width: this.tabs.body.clientWidth || 346, height: this.tabs.body.clientHeight || 180 };
      const view = aboutView(
        doc,
        n,
        area,
        {
          retry: () => this.retryAbout(n),
          credits: () => this.hooks.credits(),
          settled: settle,
        },
        6,
        this.compact,
      );
      if (view.map) open++;
      overview.replaceChildren(...view.overview);
      range.replaceChildren(...(view.range ?? []));
      this.holdRetry(this.tabs.body);
      // A phone's image sits in the head, beside the name (about.ts).
      for (const old of slots.head.querySelectorAll('.panel-head-image')) old.remove();
      slots.head.classList.toggle('has-image', view.headImage !== null);
      if (view.headImage) {
        view.headImage.classList.add('panel-head-image');
        slots.head.append(view.headImage);
      }
      const lead = slots.head.querySelector('.panel-lead');
      if (lead && view.common) lead.textContent = view.common;
      const meta = slots.head.querySelector('.panel-meta');
      for (const old of slots.head.querySelectorAll('.about-authority, .authority-sep')) old.remove();
      if (meta && view.authority) {
        if (meta.childNodes.length > 0) meta.append(el('span', { className: 'authority-sep', text: ' · ' }));
        meta.append(view.authority);
      }
      for (const old of slots.facts.querySelectorAll('.fact-links')) old.remove();
      if (view.links) {
        const ids = slots.facts.querySelector('.fact-ids');
        const r = el('div', { className: 'fact fact-links' }, [el('dt', { text: 'Links' }), el('dd', {}, [view.links])]);
        if (ids) ids.before(r);
        else slots.facts.append(r);
      }
      this.fillCredit(view.credits);
      this.fitters.set('overview', () => {
        const col = overview.querySelector<HTMLElement>('.ov-text');
        if (!col) return;
        unfit(col);
        fitExtracts(col, col, this.compact ? 4 : 6, 2);
        dropUntilFits(col, [col.querySelector('.about-note')]);
        if (overflows(col)) fitExtracts(col, col, 1, 1);
        clipBlocks(col);
      });
      this.fitters.set('range', () => {
        unfit(range);
        const lines = range.querySelector<HTMLElement>('.about-where-text');
        if (lines) clipBlocks(lines, range);
        clipBlocks(range);
      });
      const img = overview.querySelector<HTMLImageElement>('.about-image');
      if (img && !img.complete) {
        open++;
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
        img.addEventListener('load', () => this.fit('overview'), { once: true });
      }
      this.setTabs(view.range ? ['overview', 'range', 'tree'] : ['overview', 'tree']);
      this.obstacles.changed();
    } catch (err) {
      if (ctl.signal.aborted || this.shown !== n) return;
      console.warn('about', err);
      overview.replaceChildren(aboutError(() => this.retryAbout(n)));
      if (this.tabs.shown().includes('range')) range.replaceChildren(aboutError(() => this.retryAbout(n)));
      this.holdRetry(this.tabs.body);
    } finally {
      // Replaced or closed: stop counting this one at once.
      if (ctl.signal.aborted) finish();
      else settle();
      if (this.aboutCtl === ctl) this.aboutCtl = null;
    }
  }

  /** A Retry click: refetch now, and hold every Retry button for RETRY_HOLD_MS. */
  private retryAbout(n: NodeInfo): void {
    this.retryAt = performance.now();
    void this.loadAbout(n, true);
  }

  /** Disables the Retry buttons in `section` until RETRY_HOLD_MS after the last click, so they cannot hammer the server. */
  private holdRetry(section: HTMLElement): void {
    const left = this.retryAt + RETRY_HOLD_MS - performance.now();
    if (left <= 0) return;
    const buttons = [...section.querySelectorAll<HTMLButtonElement>('.about-notice button, .about-failed button')];
    for (const b of buttons) b.disabled = true;
    window.setTimeout(() => {
      for (const b of buttons) b.disabled = false;
    }, left);
  }

  /** "16.1" from the data version, for the credit line and Open Tree links. */
  private synthVersion(): string {
    return /^otl([\d.]+)/.exec(this.dataVersion)?.[1] ?? '';
  }

  /**
   * Lineage, root first, as clickable names (placeholders and unnamed nodes
   * skipped). `fit` keeps the nearest ones that fit LINEAGE_LINES lines,
   * after a "…" whose title is the whole trail (the breadcrumb has it too).
   */
  private lineage(n: NodeInfo): { node: HTMLElement; fit: () => void } | null {
    const segs = segments(n).filter((s) => s.id !== n.id);
    if (segs.length === 0) return null;
    const ol = el('ol', { className: 'panel-lineage', label: 'Lineage' });
    const fill = (keep: number): void => {
      const shown = segs.slice(-keep);
      ol.replaceChildren();
      if (shown.length < segs.length) {
        const more = el('li', { className: 'lineage-more', text: '…', title: segs.map((s) => s.name).join(' › ') });
        ol.append(more, ' ');
      }
      for (const s of shown) {
        const b = el('button', { className: 'text-button', title: `Select ${s.name}` }, nameNodes(s.runs));
        b.type = 'button';
        b.addEventListener('click', () => this.hooks.select(s.id));
        // A real space between items is where lines may break.
        ol.append(el('li', {}, [b]), ' ');
      }
    };
    fill(segs.length);
    const fit = (): void => {
      fill(segs.length);
      const line = parseFloat(getComputedStyle(ol).lineHeight) || 19;
      for (let keep = segs.length; keep > 1 && ol.offsetHeight > line * LINEAGE_LINES + 2; keep--) fill(keep - 1);
    };
    return { node: ol, fit };
  }

  /**
   * The largest children, by species count, clickable. `fit` shows as many
   * as fit (at most CHILDREN_MAX), then "+N more" pages on through the rest.
   */
  private children(n: NodeInfo): { node: HTMLElement; fit: (over: () => boolean, least: number) => void } | null {
    const top = n.children.top;
    if (top.length === 0) return null;
    const wrap = el('div');
    const ul = el('ul', { className: 'panel-children' });
    const more = el('button', { className: 'text-button more' });
    more.type = 'button';
    let per = Math.min(CHILDREN_MAX, top.length);
    let from = 0;
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
    const fill = (): void => {
      ul.replaceChildren(...top.slice(from, from + per).map(item));
      const left = n.children.total - (from + per);
      more.hidden = top.length <= per;
      more.textContent = from + per >= top.length ? 'Back to the largest' : `+${nf.format(left)} more`;
    };
    more.addEventListener('click', () => {
      from = from + per >= top.length ? 0 : from + per;
      fill();
    });
    wrap.append(ul, more);
    fill();
    const fit = (over: () => boolean, least: number): void => {
      per = Math.min(CHILDREN_MAX, top.length);
      from = 0;
      fill();
      while (over() && per > least) {
        per--;
        fill();
      }
    };
    return { node: wrap, fit };
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
}
