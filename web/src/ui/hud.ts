// The persistent HUD (DESIGN.md §4.1, PLAN §7.10): the breadcrumb and
// readout at the bottom left, the kingdom key at the bottom right, and the
// 1 px loading line at the top. Zoom has its own control on the left edge
// (ui/zoomstrip.ts), whose reset button calls `reset` here.
//
// The breadcrumb is the selection's lineage (there is always a selection,
// selection.ts), so the canvas, the card and the HUD never name different
// nodes. Its segments select that clade and fly to it. The kingdom key
// selects a group's largest root clade the same way. Reset goes back to
// minimum zoom with the selection on the anchor.
//
// The HUD registers its text and controls as obstacles (ui/obstacles.ts):
// labels keep clear of them and the renderer darkens the tree behind them,
// so the DOM stays flat (no opaque plates). It re-registers whenever the
// breadcrumb or readout changes size.

import { toRad } from '../angle';
import { tipsInView } from '../inview';
import type { NodeStore } from '../nodes';
import { isPlaceholderName, nameRuns, nameSpans, type NameRun } from '../names';
import { DIM_HUD } from '../style';
import type { Scene } from '../scene';
import type { Meta, NodeInfo } from '../types';
import { type Obstacle, elementBox, textBox, union } from './obstacles';

/** The progress line shows only for loads longer than this. */
const PROGRESS_DELAY_MS = 250;
/** The first view still loading after this long says why it is slow, ms. */
const SLOW_LOAD_MS = 8000;
/**
 * Kingdom key: swatch colours (DESIGN.md §2.2), in the order the groups
 * come clockwise round the default view, starting at Animals (upper left).
 */
const KEY: readonly { id: number; swatch: string }[] = [
  { id: 0, swatch: '--k-animals-start' },
  { id: 1, swatch: '--k-fungi-end' },
  { id: 2, swatch: '--k-plants-start' },
  { id: 3, swatch: '--k-protists' },
  { id: 4, swatch: '--k-bacteria' },
  { id: 5, swatch: '--k-archaea' },
];

const nf = new Intl.NumberFormat('en');

/** The swatch colour (a CSS variable) for a group id, or null for a mixed group (search rows use it too). */
export function groupSwatch(group: number): string | null {
  return KEY.find((k) => k.id === group)?.swatch ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string; label?: string } = {},
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

function need<T extends Element>(sel: string, type: new () => T): T {
  const e = document.querySelector(sel);
  if (!(e instanceof type)) throw new Error(`hud: ${sel} is missing`);
  return e;
}

/** "otl16.1-ott3.7.3-02e1d1" → "OpenTree 16.1". */
export function versionLabel(dataVersion: string): string {
  const m = /^otl([\d.]+)/.exec(dataVersion);
  return m ? `OpenTree ${m[1]}` : dataVersion;
}

interface Segment {
  id: number;
  name: string;
  runs: NameRun[];
}

/**
 * The named nodes of a lineage, root first, ending with the node itself if
 * named. OTT placeholders ("h2007-2", "… incertae sedis") are skipped.
 */
export function segments(node: NodeInfo): Segment[] {
  const life = (): Segment => ({ id: 0, name: 'Life', runs: [{ text: 'Life', italic: false }] });
  const out: Segment[] = [];
  const add = (id: number, name: string | null, rank: string | null): void => {
    // The root ("cellular organisms") reads as Life.
    if (id === 0) out.push(life());
    else if (name && !isPlaceholderName(name)) out.push({ id, name, runs: nameRuns(name, rank) });
  };
  for (const a of node.lineage) add(a.id, a.name, a.rank);
  add(node.id, node.name, node.rank);
  if (out[0]?.id !== 0) out.unshift(life());
  return out;
}

export class Hud {
  private readonly scene: Scene;
  private readonly meta: Meta;
  private readonly crumbs: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly readoutCount: HTMLElement;
  private readonly readoutVersion: HTMLElement;
  private readonly readoutStop: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly store: NodeStore;
  private readonly version: string;

  /** The current selection (set by main.ts from selection.ts). */
  selected: () => NodeInfo | null = () => null;
  /** Selects a node and flies to it (set by main.ts from selection.ts). */
  select: (ref: number | string) => void = () => {};
  /** Whether the idle tour is moving the selection (tour.ts), and how to stop it (main.ts). */
  touring: () => boolean = () => false;
  stopTour: () => void = () => {};
  /**
   * A first visit's one-line hint on how to drive the wheel, shown in the
   * readout until the first input (main.ts sets it, and clears it).
   */
  hint: string | null = null;

  /** Node whose lineage is shown. */
  private shownId = -1;
  private readoutText = '';
  private loadStart = -1;
  private settledOnce = false;
  private firstFrame = -1;

  constructor(scene: Scene, meta: Meta, store: NodeStore) {
    this.scene = scene;
    this.meta = meta;
    this.store = store;
    this.version = versionLabel(meta.dataVersion);
    this.crumbs = need('.breadcrumb', HTMLElement);
    this.readout = need('.readout', HTMLElement);
    this.readout.title = `Data version ${meta.dataVersion}`;
    // The version is dropped on narrow screens (styles.css), so the count stays on one line.
    this.readoutCount = el('span');
    this.readoutVersion = el('span', { className: 'readout-version', text: ` · ${this.version}` });
    // While the tour runs: "Touring · 864,899 species in view · Stop".
    const stop = el('button', { className: 'text-button readout-stop', text: 'Stop', title: 'Stop the tour' });
    stop.type = 'button';
    stop.addEventListener('click', () => this.stopTour());
    this.readoutStop = el('span', { className: 'readout-tour' }, [' · ', stop]);
    this.readoutStop.hidden = true;
    this.readout.replaceChildren(this.readoutCount, this.readoutVersion, this.readoutStop);
    this.progress = el('div', { className: 'progress' });
    this.progress.setAttribute('aria-hidden', 'true');
    document.body.append(this.progress);
    this.buildKey();
    scene.input.onDrag = (dragging) => document.documentElement.classList.toggle('dragging', dragging);
    scene.obstacles.set('hud', () => this.obstacles());
    window.addEventListener('resize', () => scene.obstacles.changed());
  }

  /**
   * The HUD's boxes: the wordmark, the status block (breadcrumb and
   * readout text) and the controls (zoom buttons and key). Labels keep
   * clear of them, out to the screen edge, and the tree darkens behind them.
   */
  private obstacles(): Obstacle[] {
    const out: Obstacle[] = [];
    const add = (box: ReturnType<typeof textBox>): void => {
      if (box) out.push({ box, keepClear: true, toEdge: true, dim: DIM_HUD });
    };
    add(textBox(document.querySelector('.wordmark')));
    add(union(textBox(this.crumbs), textBox(this.readout)));
    add(elementBox(document.querySelector('.hud-controls')));
    return out;
  }

  /** Called after every frame: the readout, and the breadcrumb when the selection changed. */
  frame(now: number): void {
    this.updateReadout(now);
    const sel = this.selected();
    if (sel) this.renderCrumbs(sel);
  }

  private updateReadout(now: number): void {
    const scene = this.scene;
    const view = scene.lastView;
    if (!view) return;
    const pending = scene.cache.pending();
    const wanted = view.keys.length;
    if (this.firstFrame < 0) this.firstFrame = now;
    let text: string;
    let touring = false;
    let plain = false;
    if (!this.settledOnce && pending > 0) {
      // Truthful loading line until the first view is complete (DESIGN.md §7).
      const slow = now - this.firstFrame > SLOW_LOAD_MS ? ' · slow connection' : '';
      text = `Loading tree · ${nf.format(wanted - pending)} / ${nf.format(wanted)} tiles${slow}`;
    } else {
      this.settledOnce = true;
      const n = tipsInView(scene.camera, this.meta.tipCount);
      const count = `${n === null ? '—' : nf.format(n)} species in view`;
      touring = this.touring();
      if (touring) text = `Touring · ${count}`;
      else if (this.hint) text = this.hint;
      else {
        text = count;
        plain = true;
      }
    }
    const key = `${text}|${touring}|${plain}`;
    if (key !== this.readoutText) {
      this.readoutText = key;
      this.readoutCount.textContent = text;
      this.readoutVersion.hidden = !plain && !touring;
      this.readoutStop.hidden = !touring;
      this.scene.obstacles.changed();
    }
    // The 1 px progress line, for loads that take a moment.
    if (pending > 0) {
      if (this.loadStart < 0) this.loadStart = now;
      const show = now - this.loadStart > PROGRESS_DELAY_MS;
      this.progress.style.transform = `scaleX(${wanted > 0 ? (wanted - pending) / wanted : 0})`;
      this.progress.classList.toggle('on', show);
    } else {
      this.loadStart = -1;
      this.progress.classList.remove('on');
    }
  }

  private renderCrumbs(n: NodeInfo): void {
    if (n.id === this.shownId) return;
    this.shownId = n.id;
    const segs = segments(n);
    const nav = this.crumbs;
    // Middle-truncate: keep the first segment and as many of the last ones
    // as fit ("Life › … › Felidae › Panthera").
    let keep = segs.length - 1;
    nav.replaceChildren(...this.crumbNodes(segs, keep));
    while (keep > 1 && nav.scrollWidth > nav.clientWidth + 1) {
      keep--;
      nav.replaceChildren(...this.crumbNodes(segs, keep));
    }
    // Its width changed: labels re-layout around it and the plate follows.
    this.scene.obstacles.changed();
  }

  private crumbNodes(segs: Segment[], keepLast: number): Node[] {
    const out: Node[] = [];
    const hidden = segs.length - 1 - keepLast;
    segs.forEach((s, i) => {
      if (i > 0 && i <= hidden) {
        if (i === 1) {
          out.push(el('span', { className: 'sep', text: '›' }));
          const names = segs.slice(1, hidden + 1).map((x) => x.name);
          out.push(el('span', { className: 'ellipsis', text: '…', title: names.join(' › ') }));
        }
        return;
      }
      if (i > 0) out.push(el('span', { className: 'sep', text: '›' }));
      const last = i === segs.length - 1;
      const b = el('button', { className: `crumb${last ? ' current' : ''}`, title: `Go to ${s.name}` }, nameSpans(s.runs));
      b.type = 'button';
      if (last) b.setAttribute('aria-current', 'location');
      b.addEventListener('click', () => this.select(s.id));
      out.push(b);
    });
    return out;
  }

  /** Back to minimum zoom, the selection on the anchor (the zoom strip's reset button). */
  reset(): void {
    const rig = this.scene.rig;
    const sel = this.selected();
    this.scene.input.cancel();
    this.scene.flight.fly({ theta: sel ? toRad(sel.angle) : rig.theta, scale: rig.minScale() });
    this.scene.requestRender();
  }

  private buildKey(): void {
    const ul = need('.kingdom-key', HTMLElement);
    const items: Node[] = [];
    for (const k of KEY) {
      const g = this.meta.groups.find((x) => x.id === k.id);
      if (!g) continue;
      const sw = el('span', { className: 'swatch' });
      sw.style.background = `var(${k.swatch})`;
      const b = el('button', { title: `Go to ${g.name}` }, [sw, g.name]);
      b.type = 'button';
      b.addEventListener('click', () => void this.flyToGroup(g.id));
      items.push(el('li', {}, [b]));
    }
    ul.replaceChildren(...items);
  }

  /** Selects a group's largest root clade and flies there (the key; the wordmark menu's kingdom rows on a phone). */
  goToGroup(group: number): void {
    void this.flyToGroup(group);
  }

  /** Selects a group's largest root clade (a group may have several, e.g. the protists). */
  private async flyToGroup(group: number): Promise<void> {
    const g = this.meta.groups.find((x) => x.id === group);
    if (!g) return;
    let best: NodeInfo | null = null;
    for (const id of g.rootIds) {
      try {
        const n = await this.store.get(id);
        if (!best || n.leafCount > best.leafCount) best = n;
      } catch (err) {
        console.warn('kingdom key', err);
      }
    }
    if (best) this.select(best.id);
  }
}
