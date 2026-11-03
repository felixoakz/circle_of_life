// The search palette (DESIGN.md §4.4, PLAN §7.10, §7.11): opened with "/",
// ⌘K / Ctrl+K or the search field at the top right. A WAI-ARIA combobox:
// the input has role="combobox", aria-expanded and aria-activedescendant,
// the results are a listbox of options, and focus stays in the input while
// ↑/↓ move the active option, Enter chooses it and Esc closes.
//
// Typing is debounced (120 ms) and the previous request aborted; answers
// are cached per query, so backspacing is instant. Enter pressed before the
// answer is in waits for it and takes the first result, so "homo sapiens⏎"
// typed quickly still works. Choosing a result selects the node and flies
// to it (selection.ts, flyto.ts).
//
// With nothing typed yet it lists "Recent" (this visit's own selections)
// and "Try" (the tour's species, by common name), so an empty palette is a
// way in. Results named like sequencing leftovers ("Rosaceae environmental
// sample", "uncultured …") go to the end of the list (`isJunkName`).
//
// The trigger is a 40 px bar with a magnifier, "Search 2.3M species" and a
// "/" hint: on desktop as wide as the card, right above it; on a phone it
// fills the top row beside the wordmark.
//
// On desktop it opens in place of its trigger at the top right, over the
// card (`place`); on a phone it spans the top.
//
// Rows: the kingdom swatch, the name in its proper style (names.ts) with
// the matched letters at weight 600 (for a common-name match, "jaguar ·
// Panthera onca", with a language tag when it is not English), then the
// rank (text-2; not for species) and the lineage context (text-3). While open, the tree behind is dimmed to 50% by the
// renderer (one more obstacle plate, ui/obstacles.ts) and the label overlay
// with it; the palette itself is opaque, with no blur.

import { fetchSearch } from '../api';
import { type NameRun, nameRuns } from '../names';
import type { Obstacle, Obstacles } from './obstacles';
import { groupSwatch } from './hud';
import { rankWord } from './panel';
import type { SearchHit } from '../types';
import { FLAG_HOME } from '../tiles/decode';

const DEBOUNCE_MS = 120;
const LIMIT = 8;
/** Queries shorter than this are not sent (the API answers [] anyway). */
const MIN_CHARS = 2;
/** From this length an empty answer says "No taxon matches" (shorter ones match whole words only, PLAN §5.2). */
const EMPTY_MIN_CHARS = 3;
/** The progress hairline shows only for answers slower than this. */
const PROGRESS_DELAY_MS = 150;
/** Close transition (DESIGN.md §6: 160–220 ms). */
const CLOSE_MS = 180;
/** The tree behind the open palette: 50% (DESIGN.md §4.4). */
const DIM_SEARCH = 0.5;
const CACHE_SIZE = 64;
/** Recent selections kept for the empty palette. */
const RECENT_MAX = 4;
/** Rows in the empty palette, Recent and Try together. */
const SUGGEST_MAX = 6;
/** The docked palette's least width, CSS px. */
const DOCK_MIN_W = 400;

// ---- Pure helpers (search.test.ts) ----

/** Names that are sequencing leftovers rather than taxa a visitor means. */
export function isJunkName(name: string | null): boolean {
  return name !== null && /environmental sample|metagenome|uncultured|unidentified/i.test(name);
}

/** Hits with real names first, leftovers last, each group in the server's order. */
export function junkLast(hits: readonly SearchHit[]): SearchHit[] {
  return [...hits.filter((h) => !isJunkName(h.name)), ...hits.filter((h) => isJunkName(h.name))];
}

/** A suggestion row (Recent, Try) in a search hit's shape: `id` −1 when only the OpenTree id is known. */
export function suggestion(s: {
  id?: number;
  nodeId: string;
  name: string;
  rank: string | null;
  group: number;
  flags?: number;
  common: string | null;
  lineage?: string[];
}): SearchHit {
  return {
    id: s.id ?? -1,
    nodeId: s.nodeId,
    name: s.name,
    rank: s.rank,
    group: s.group,
    flags: s.flags ?? 0,
    leafCount: 1,
    childCount: 0,
    level: 0,
    angle: 0,
    arcLo: 0,
    arcHi: 0,
    r: 1,
    matched: s.common ?? s.name,
    matchedKind: s.common ? 'vernacular' : 'scientific',
    matchedLang: s.common ? 'en' : null,
    commonName: s.common,
    lineage: s.lineage ?? [],
  };
}

/** Trims and collapses whitespace: the query as the API sees it (it lowercases too). */
export function normaliseQuery(q: string): string {
  return q.trim().split(/\s+/).filter(Boolean).join(' ');
}

/** One character folded the way the FTS tokenizer folds it: lowercase, no diacritics. */
function fold(c: string): string {
  return c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The parts of `text` the query matched, as [start, end) ranges: each query
 * word matches the start of a word in the text (the FTS index matches word
 * prefixes, PLAN §5.2), ignoring case and diacritics. Each query word
 * marks its first match.
 */
export function matchRanges(text: string, query: string): [number, number][] {
  const chars = Array.from(text);
  // Offsets in UTF-16 units of each code point, plus the end.
  const offsets: number[] = [];
  let o = 0;
  for (const c of chars) {
    offsets.push(o);
    o += c.length;
  }
  offsets.push(o);
  const folded = chars.map(fold);
  const starts: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    const prev = i > 0 ? (chars[i - 1] ?? '') : '';
    if (WORD_CHAR.test(c) && !WORD_CHAR.test(prev)) starts.push(i);
  }
  const ranges: [number, number][] = [];
  for (const word of normaliseQuery(query).split(' ')) {
    const tok = Array.from(word.replace(/"/g, '')).map(fold);
    if (tok.length === 0) continue;
    for (const s of starts) {
      if (tok.every((c, k) => folded[s + k] === c)) {
        ranges.push([offsets[s] ?? 0, offsets[s + tok.length] ?? o]);
        break;
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // Merge overlaps ("homo ho" marks "Homo" once).
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** A name run that is also marked (matched) or not. */
export interface MarkedRun extends NameRun {
  strong: boolean;
}

/** Cuts name runs further where the matched ranges start and end. */
export function markRuns(runs: readonly NameRun[], ranges: readonly [number, number][]): MarkedRun[] {
  const out: MarkedRun[] = [];
  let pos = 0;
  for (const run of runs) {
    const end = pos + run.text.length;
    const cuts = new Set([pos, end]);
    for (const [a, b] of ranges) {
      if (a > pos && a < end) cuts.add(a);
      if (b > pos && b < end) cuts.add(b);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] ?? pos;
      const b = points[i + 1] ?? end;
      const strong = ranges.some(([s, e]) => a >= s && b <= e);
      const text = run.text.slice(a - pos, b - pos);
      const last = out[out.length - 1];
      if (last && last.italic === run.italic && last.strong === strong) last.text += text;
      else out.push({ text, italic: run.italic, strong });
    }
    pos = end;
  }
  return out;
}

export type PaletteAction = 'next' | 'prev' | 'first' | 'last' | 'choose' | 'close' | null;

/** What a key does inside the palette's input (Home/End stay with the caret). */
export function paletteAction(key: string): PaletteAction {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'PageDown':
      return 'last';
    case 'PageUp':
      return 'first';
    case 'Enter':
      return 'choose';
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}

/** The active option after a move, wrapping at the ends; -1 when there are none. */
export function moveActive(active: number, count: number, move: 'next' | 'prev' | 'first' | 'last'): number {
  if (count <= 0) return -1;
  switch (move) {
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return active < 0 || active >= count - 1 ? 0 : active + 1;
    case 'prev':
      return active <= 0 ? count - 1 : active - 1;
  }
}

/** Whether a keydown opens the palette: "/" outside text fields, or ⌘K / Ctrl+K anywhere. */
export function opensPalette(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  editable: boolean;
}): boolean {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) return true;
  return e.key === '/' && !e.editable && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** "2.3M" for the trigger's "Search 2.3M species". */
export function compactCount(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

// ---- DOM ----

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

function runSpans(runs: readonly MarkedRun[]): HTMLSpanElement[] {
  return runs.map((r) => {
    const s = document.createElement('span');
    const cls = [r.italic ? 'taxon-italic' : '', r.strong ? 'match' : ''].filter(Boolean).join(' ');
    if (cls) s.className = cls;
    s.textContent = r.text;
    return s;
  });
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

export interface SearchOptions {
  /** Where the trigger goes (the top-right slot). */
  slot: HTMLElement;
  obstacles: Obstacles;
  speciesCount: number;
  /** A result was chosen: select it and fly there. */
  choose: (hit: SearchHit) => void;
  /**
   * The active result changed: fetch its node now, so choosing it starts
   * the flight without waiting for /api/nodes.
   */
  prefetch: (hit: SearchHit) => void;
  /** The home node (Homo sapiens) and the tip count: its subspecies get its white swatch. */
  home: { angle: number } | null;
  tipCount: number;
  /** Something changed that the canvas should redraw (the dim). */
  redraw: () => void;
  /** The empty palette's "Try" rows (the tour's species). */
  tryList?: readonly SearchHit[];
}

/**
 * A hit drawn white on the canvas: the home node itself, or one of its
 * tips (Homo sapiens' two subspecies, drawn as one white bar with it). Its
 * tips are the only ones within one tip slot of its angle.
 */
export function isHomeHit(hit: SearchHit, home: { angle: number } | null, tipCount: number): boolean {
  if ((hit.flags & FLAG_HOME) !== 0) return true;
  if (!home || hit.childCount !== 0) return false;
  const slot = 2 ** 32 / tipCount;
  const d = Math.abs(hit.angle - home.angle);
  return Math.min(d, 2 ** 32 - d) <= slot;
}

type Status = { kind: 'idle' } | { kind: 'results'; query: string; hits: SearchHit[] } | { kind: 'error'; query: string };

export class SearchPalette {
  private readonly opts: SearchOptions;
  private readonly trigger: HTMLButtonElement;
  private readonly layer: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private readonly message: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly cache = new Map<string, SearchHit[]>();

  private openState = false;
  private query = '';
  private status: Status = { kind: 'idle' };
  private active = -1;
  private timer = 0;
  private progressTimer = 0;
  private closeTimer = 0;
  private ctl: AbortController | null = null;
  /** Enter was pressed before the answer for the current query arrived. */
  private pendingEnter = false;
  private returnFocus: HTMLElement | null = null;
  /** The rows on show (results, or the empty palette's suggestions), in option order. */
  private rows: SearchHit[] = [];
  private recent: SearchHit[] = [];

  constructor(opts: SearchOptions) {
    this.opts = opts;

    const glass = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glass.setAttribute('viewBox', '0 0 16 16');
    glass.setAttribute('width', '16');
    glass.setAttribute('height', '16');
    glass.setAttribute('aria-hidden', 'true');
    glass.classList.add('search-glass');
    glass.innerHTML = '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1"/><path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1" stroke-linecap="square"/>';
    this.trigger = el('button', 'search-trigger', [
      el('span', 'search-trigger-label', [`Search ${compactCount(opts.speciesCount)} species`]),
      el('kbd', 'search-key', ['/']),
    ]);
    this.trigger.prepend(glass);
    this.trigger.type = 'button';
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-keyshortcuts', '/ Control+K Meta+K');
    this.trigger.addEventListener('click', () => this.open());
    opts.slot.replaceChildren(this.trigger);

    this.input = el('input', 'search-input');
    this.input.type = 'text';
    this.input.id = 'search-input';
    this.input.placeholder = 'Search species, genera, families…';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('enterkeyhint', 'go');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-controls', 'search-listbox');
    this.input.setAttribute('aria-label', 'Search the tree');

    const close = el('button', 'search-close', [el('span', 'search-close-key', ['esc']), el('span', 'search-close-word', ['Close'])]);
    close.type = 'button';
    close.setAttribute('aria-label', 'Close search');
    close.addEventListener('click', () => this.close(true));

    this.progress = el('div', 'search-progress');
    this.progress.setAttribute('aria-hidden', 'true');
    this.list = el('ul', 'search-list');
    this.list.id = 'search-listbox';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Results');
    this.list.hidden = true;
    this.message = el('p', 'search-message');
    this.message.setAttribute('role', 'status');
    this.message.hidden = true;

    this.dialog = el('div', 'search', [el('div', 'search-field', [this.input, close]), this.progress, this.list, this.message]);
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-label', 'Search');
    const backdrop = el('div', 'search-backdrop');
    backdrop.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.close(true);
    });
    this.layer = el('div', 'search-layer', [backdrop, this.dialog]);
    this.layer.hidden = true;
    document.body.append(this.layer);

    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    // Keep focus in the input when clicking a row.
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onGlobalKey(e));

    // The trigger is opaque: labels keep clear of it.
    opts.obstacles.set('search-trigger', () => {
      const r = this.trigger.getBoundingClientRect();
      if (r.width === 0) return [];
      return [{ box: { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }, keepClear: true, toEdge: true, dim: 0 }];
    });
  }

  isOpen(): boolean {
    return this.openState;
  }

  /** Remembers a selection the visitor made, for the empty palette's "Recent". */
  remember(hit: SearchHit): void {
    this.recent = [hit, ...this.recent.filter((h) => h.nodeId !== hit.nodeId)].slice(0, RECENT_MAX);
  }

  /**
   * Desktop: dock the palette over the card's place at the top right (at
   * least DOCK_MIN_W wide, growing left); null on a phone, where it spans the top.
   */
  place(card: { x0: number; x1: number } | null): void {
    // The trigger: the card's width, right above it (desktop); the rest of the top row (phone, styles.css).
    if (card) this.opts.slot.style.setProperty('--search-w', `${card.x1 - card.x0}px`);
    else this.opts.slot.style.removeProperty('--search-w');
    const d = this.dialog;
    d.classList.toggle('docked', card !== null);
    if (!card) {
      d.style.removeProperty('--search-left');
      d.style.removeProperty('--search-width');
      return;
    }
    const w = Math.max(DOCK_MIN_W, card.x1 - card.x0);
    const left = Math.max(16, card.x1 - w);
    d.style.setProperty('--search-left', `${left}px`);
    d.style.setProperty('--search-width', `${card.x1 - left}px`);
  }

  /** True while an answer is on its way (the scene is not idle yet). */
  busy(): boolean {
    return this.timer !== 0 || this.ctl !== null;
  }

  open(): void {
    if (this.openState) {
      this.input.select();
      return;
    }
    window.clearTimeout(this.closeTimer);
    this.openState = true;
    const focused = document.activeElement;
    this.returnFocus = focused instanceof HTMLElement && focused !== document.body ? focused : this.trigger;
    this.layer.hidden = false;
    document.documentElement.classList.add('searching');
    // Next frame, so the opening transition runs from the hidden state.
    requestAnimationFrame(() => this.layer.classList.add('open'));
    this.input.focus({ preventScroll: true });
    this.input.select();
    this.render();
    this.opts.obstacles.set('search', () => this.dimBoxes());
    this.opts.redraw();
  }

  /** Closes; `restore` returns focus to where it was (not after choosing: the panel takes it). */
  close(restore: boolean): void {
    if (!this.openState) return;
    this.openState = false;
    this.pendingEnter = false;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.ctl?.abort();
    this.ctl = null;
    this.setProgress(false);
    this.layer.classList.remove('open');
    document.documentElement.classList.remove('searching');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.closeTimer = window.setTimeout(() => {
      if (!this.openState) this.layer.hidden = true;
    }, CLOSE_MS);
    this.opts.obstacles.set('search', null);
    if (restore && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
    this.opts.redraw();
  }

  /** The whole screen, darkened behind the palette (a plate well past the edges, so its soft rim is off screen). */
  private dimBoxes(): Obstacle[] {
    const m = 200;
    return [
      { box: { x0: -m, y0: -m, x1: window.innerWidth + m, y1: window.innerHeight + m }, keepClear: false, toEdge: false, dim: DIM_SEARCH },
    ];
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const opens = opensPalette({
      key: e.key,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      editable: isEditable(e.target),
    });
    if (!opens) return;
    e.preventDefault();
    this.open();
  }

  private onInput(): void {
    this.pendingEnter = false;
    this.query = normaliseQuery(this.input.value);
    window.clearTimeout(this.timer);
    this.timer = 0;
    if (this.query.length < MIN_CHARS) {
      this.ctl?.abort();
      this.ctl = null;
      this.setProgress(false);
      this.status = { kind: 'idle' };
      this.render();
      return;
    }
    const cached = this.cache.get(this.query.toLowerCase());
    if (cached) {
      this.ctl?.abort();
      this.ctl = null;
      this.setProgress(false);
      this.show(this.query, cached);
      return;
    }
    // Typing past the empty palette: its suggestions go at once, not when the answer comes.
    if (this.status.kind === 'idle') this.render();
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.run(this.query);
    }, DEBOUNCE_MS);
  }

  private async run(query: string): Promise<void> {
    this.ctl?.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    window.clearTimeout(this.progressTimer);
    this.progressTimer = window.setTimeout(() => this.setProgress(true), PROGRESS_DELAY_MS);
    try {
      const hits = await fetchSearch(query, LIMIT, ctl.signal);
      if (ctl.signal.aborted) return;
      if (this.cache.size >= CACHE_SIZE) this.cache.clear();
      this.cache.set(query.toLowerCase(), junkLast(hits));
      if (query === this.query) this.show(query, junkLast(hits));
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.warn('search', err);
      this.pendingEnter = false;
      this.status = { kind: 'error', query };
      this.render();
    } finally {
      if (this.ctl === ctl) {
        this.ctl = null;
        this.setProgress(false);
      }
    }
  }

  private show(query: string, hits: SearchHit[]): void {
    this.status = { kind: 'results', query, hits };
    this.active = hits.length > 0 ? 0 : -1;
    this.render();
    if (this.pendingEnter) {
      this.pendingEnter = false;
      if (hits.length > 0) this.choose(0);
    }
  }

  private onInputKey(e: KeyboardEvent): void {
    const action = paletteAction(e.key);
    if (e.key === 'Tab') {
      // The palette is modal and the input is its only stop (the close button is for pointers).
      e.preventDefault();
      return;
    }
    if (!action || e.isComposing) return;
    e.preventDefault();
    if (action === 'close') {
      this.close(true);
      return;
    }
    const shown = (this.status.kind === 'results' && this.status.query === this.query) || this.query.length < MIN_CHARS;
    const hits = shown ? this.rows : null;
    if (action === 'choose') {
      if (hits && hits.length > 0) this.choose(Math.max(0, this.active));
      else if (this.query.length >= MIN_CHARS && this.status.kind !== 'error') {
        // The answer is not in yet: ask now and take the first result.
        this.pendingEnter = true;
        if (this.timer !== 0) {
          window.clearTimeout(this.timer);
          this.timer = 0;
          void this.run(this.query);
        }
      }
      return;
    }
    if (!hits) return;
    this.setActive(moveActive(this.active, hits.length, action));
  }

  private choose(index: number): void {
    const hit = this.rows[index];
    if (!hit) return;
    this.close(false);
    this.opts.choose(hit);
  }

  private setActive(index: number): void {
    this.active = index;
    const options = this.list.querySelectorAll<HTMLElement>('[role="option"]');
    options.forEach((o, i) => o.setAttribute('aria-selected', String(i === index)));
    const current = options[index];
    if (current) {
      this.input.setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({ block: 'nearest' });
      this.prefetchActive();
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  private setProgress(on: boolean): void {
    if (!on) window.clearTimeout(this.progressTimer);
    this.progress.classList.toggle('on', on);
  }

  private render(): void {
    const st = this.status;
    const current = st.kind !== 'idle' && st.query === this.query && this.query.length >= MIN_CHARS;
    const idle = this.query.length < MIN_CHARS;
    let hits: SearchHit[] = current && st.kind === 'results' ? st.hits : [];
    const items: HTMLLIElement[] = [];
    if (idle) {
      // The empty palette: what the visitor chose before, then a few to try.
      const recent = this.recent;
      const seen = new Set(recent.map((h) => h.nodeId));
      const tries = (this.opts.tryList ?? []).filter((h) => !seen.has(h.nodeId)).slice(0, Math.max(0, SUGGEST_MAX - recent.length));
      hits = [...recent, ...tries];
      const heading = (text: string): HTMLLIElement => {
        const li = el('li', 'search-heading', [text]);
        li.setAttribute('role', 'presentation');
        return li;
      };
      if (recent.length > 0) items.push(heading('Recent'), ...recent.map((h, i) => this.row(h, i)));
      if (tries.length > 0) items.push(heading('Try'), ...tries.map((h, i) => this.row(h, recent.length + i)));
    } else {
      items.push(...hits.map((h, i) => this.row(h, i)));
    }
    this.rows = hits;
    this.list.replaceChildren(...items);
    this.list.hidden = hits.length === 0;
    this.input.setAttribute('aria-expanded', String(hits.length > 0));
    this.setActive(hits.length > 0 ? Math.min(Math.max(this.active, 0), hits.length - 1) : -1);

    this.message.replaceChildren();
    this.message.classList.remove('error');
    if (current && st.kind === 'error') {
      const retry = el('button', 'text-button', ['Retry']);
      retry.type = 'button';
      retry.addEventListener('click', () => {
        void this.run(this.query);
        this.input.focus();
      });
      this.message.append('Search is unavailable right now. ', retry);
      this.message.classList.add('error');
    } else if (current && st.kind === 'results' && hits.length === 0 && this.query.length >= EMPTY_MIN_CHARS) {
      this.message.append(`No taxon matches “${this.query}”. Try a genus or a common name.`);
    }
    this.message.hidden = this.message.childNodes.length === 0;
  }

  private row(hit: SearchHit, index: number): HTMLLIElement {
    const li = el('li', 'search-row');
    li.id = `search-opt-${index}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === this.active));

    const swatch = el('span', 'swatch');
    const home = isHomeHit(hit, this.opts.home, this.opts.tipCount);
    const colour = home ? '--k-home' : groupSwatch(hit.group);
    swatch.style.background = colour ? `var(${colour})` : 'var(--text-3)';
    swatch.setAttribute('aria-hidden', 'true');

    const name = hit.name ?? hit.matched;
    const nameEl = el('span', 'search-name');
    if (hit.matchedKind === 'vernacular') {
      // "jaguar · Panthera onca" (DESIGN.md §4.4): the common name in the
      // sans, the scientific name in its own style. A name in another
      // language than the UI's English says which ("Onca pt").
      const common = el('span', 'search-common', runSpans(markRuns([{ text: hit.matched, italic: false }], matchRanges(hit.matched, this.query))));
      if (hit.matchedLang) common.lang = hit.matchedLang;
      nameEl.append(common);
      if (hit.matchedLang && hit.matchedLang !== 'en') nameEl.append(el('span', 'search-lang', [hit.matchedLang]));
      nameEl.append(el('span', 'search-sep', [' · ']), ...runSpans(markRuns(nameRuns(name, hit.rank), [])));
    } else {
      nameEl.append(...runSpans(markRuns(nameRuns(name, hit.rank), matchRanges(name, this.query))));
    }

    const context = el('span', 'search-context');
    // "species" is left out: the italic binomial already says it, and the
    // lineage gets the room (DESIGN.md §4.4 shows ranks on higher taxa only).
    const rank = hit.rank === 'species' ? null : rankWord(hit.rank);
    if (rank) context.append(el('span', 'search-rank', [rank]));
    if (hit.lineage.length > 0) {
      if (rank) context.append(el('span', 'search-dot', [' · ']));
      const lin = el('span', 'search-lineage');
      hit.lineage.forEach((n, i) => {
        if (i > 0) lin.append(el('span', 'search-lineage-sep', [' › ']));
        lin.append(el('span', 'search-lineage-name', [n]));
      });
      context.append(lin);
    }

    li.append(swatch, nameEl, context);
    li.addEventListener('pointermove', () => {
      if (this.active !== index) this.setActiveNoScroll(index);
    });
    li.addEventListener('click', () => this.choose(index));
    return li;
  }

  /** Pointer hover: activate without scrolling the list under the pointer. */
  private setActiveNoScroll(index: number): void {
    this.active = index;
    const options = this.list.querySelectorAll<HTMLElement>('[role="option"]');
    options.forEach((o, i) => o.setAttribute('aria-selected', String(i === index)));
    const current = options[index];
    if (current) this.input.setAttribute('aria-activedescendant', current.id);
    this.prefetchActive();
  }

  private prefetchActive(): void {
    const hit = this.rows[this.active];
    if (hit) this.opts.prefetch(hit);
  }
}
