// The persistent HUD (DESIGN.md §4.1, PLAN §7.10): the breadcrumb and
// readout at the bottom left, zoom buttons and the kingdom key at the bottom
// right, and the 1 px loading line at the top.
//
// Breadcrumb. The node under the screen centre is found in the loaded tiles
// (reticle.ts, at most 4 times a second), but its full lineage is not: an
// ancestor's tile is the one holding its arc's midpoint, which is usually
// off screen and not loaded. So the lineage comes from /api/nodes/{id}
// (debounced 120 ms, the previous request aborted, answers cached in the
// NodeStore shared with hover and the panel). The
// local lookup keeps requests rare: one per change of node under the
// reticle, not one per frame. Segments fly the camera to that clade.
//
// With a selection whose point is on screen, the breadcrumb is the
// selection's lineage instead (the white path and the panel name the same
// node, so the HUD never contradicts them); panning the selection away
// hands it back to the reticle.
//
// The HUD registers its text and controls as obstacles (ui/obstacles.ts):
// labels keep clear of them and the renderer darkens the tree behind them,
// so the DOM stays flat (no opaque plates). It re-registers whenever the
// breadcrumb or readout changes size.

import { TWO_32, fromRad, toRad } from '../angle';
import { type Pose, arcRadians, cladePose, wheelPose } from '../flyto';
import { tipsInView } from '../inview';
import type { NodeStore } from '../nodes';
import { isPlaceholderName, nameRuns, nameSpans, type NameRun } from '../names';
import { nodeAtReticle } from '../reticle';
import { DIM_HUD } from '../style';
import type { Scene } from '../scene';
import type { Meta, NodeInfo } from '../types';
import { type Obstacle, elementBox, textBox, union } from './obstacles';

const PROBE_MS = 250;
const FETCH_DEBOUNCE_MS = 120;
/** The progress line shows only for loads longer than this. */
const PROGRESS_DELAY_MS = 250;
const ZOOM_STEP = 1.5;
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

/** Zoom and reset icons: 1 px strokes on a 16 px grid, so they match the text weight on every OS. */
const ICONS: Record<'minus' | 'plus' | 'reset', string> = {
  minus: 'M3.5 8h9',
  plus: 'M3.5 8h9M8 3.5v9',
  // An open circle with an arrowhead: "back to the start".
  reset: 'M12.2 5.6A4.8 4.8 0 1 0 12.8 9M12.6 2.8v3h-3',
};

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
  private readonly progress: HTMLElement;
  private readonly store: NodeStore;
  private readonly version: string;

  /** The current selection, if any (set by main.ts from selection.ts). */
  selected: () => NodeInfo | null = () => null;

  private lastProbe = -Infinity;
  /** Camera and tiles as of the last probe; no new probe until they change. */
  private probedKey = '';
  private probeTimer = 0;
  private fetchTimer = 0;
  private ctl: AbortController | null = null;
  /** Node whose lineage is shown, and the one wanted next. */
  private shownId = -1;
  private wantedId = -1;
  private readoutText = '';
  private loadStart = -1;
  private settledOnce = false;

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
    this.readout.replaceChildren(this.readoutCount, this.readoutVersion);
    this.progress = el('div', { className: 'progress' });
    this.progress.setAttribute('aria-hidden', 'true');
    document.body.append(this.progress);
    this.buildControls();
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

  /** True while the breadcrumb is still catching up (the scene is not idle yet). */
  busy(): boolean {
    return this.probeTimer !== 0 || this.fetchTimer !== 0 || this.ctl !== null;
  }

  /** Called after every frame: readout now, breadcrumb throttled. */
  frame(now: number): void {
    this.updateReadout(now);
    if (this.probeKey() === this.probedKey) return;
    if (now - this.lastProbe >= PROBE_MS) {
      this.probe();
    } else if (this.probeTimer === 0) {
      // Trailing probe, so the breadcrumb settles where the camera stopped.
      this.probeTimer = window.setTimeout(() => {
        this.probeTimer = 0;
        this.probe();
        this.scene.requestOverlay();
      }, PROBE_MS - (now - this.lastProbe));
    }
  }

  private updateReadout(now: number): void {
    const scene = this.scene;
    const view = scene.lastView;
    if (!view) return;
    const pending = scene.cache.pending();
    const wanted = view.keys.length;
    let text: string;
    if (!this.settledOnce && pending > 0) {
      // Truthful loading line until the first view is complete (DESIGN.md §7).
      text = `Loading tree · ${nf.format(wanted - pending)} / ${nf.format(wanted)} tiles`;
    } else {
      this.settledOnce = true;
      const n = tipsInView(scene.camera, this.meta.tipCount);
      text = `${n === null ? '—' : nf.format(n)} species in view`;
    }
    if (text !== this.readoutText) {
      this.readoutText = text;
      this.readoutCount.textContent = text;
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

  private probeKey(): string {
    const cam = this.scene.camera;
    const sel = this.selected();
    return `${cam.angle},${cam.r},${cam.scale},${this.scene.lastView?.level},${this.scene.lastTiles.length},${sel?.id}`;
  }

  private probe(): void {
    this.lastProbe = performance.now();
    this.probedKey = this.probeKey();
    const view = this.scene.lastView;
    if (!view) return;
    const cam = this.scene.camera;
    // A hair under half a slot: exactly between two tips (where a species
    // with two subspecies sits) reads as the parent, not either tip.
    const halfSlot = (TWO_32 / this.meta.tipCount / 2) * 0.999;
    const hit = nodeAtReticle(this.scene.lastTiles, fromRad(cam.angle), cam.r, view.level, halfSlot);
    const sel = this.selected();
    const id = sel && this.onScreen(sel) ? sel.id : (hit?.id ?? 0);
    if (id === this.wantedId) return;
    this.wantedId = id;
    window.clearTimeout(this.fetchTimer);
    this.fetchTimer = window.setTimeout(() => {
      this.fetchTimer = 0;
      void this.load(id);
    }, FETCH_DEBOUNCE_MS);
  }

  /**
   * True when a node's place on the rim (the middle of its tips, where a
   * flight to it frames it) is inside the window. The rim, not the node's
   * own point: deep in, a species with subspecies has its fork off screen
   * while its tips fill the view.
   */
  private onScreen(n: NodeInfo): boolean {
    const cam = this.scene.camera;
    const p = cam.polarToScreen(toRad(n.angle), n.lineage.length === 0 ? 0 : 1);
    return p.x >= 0 && p.y >= 0 && p.x <= cam.width && p.y <= cam.height;
  }

  private node(id: number, signal?: AbortSignal): Promise<NodeInfo> {
    return this.store.get(id, signal);
  }

  private async load(id: number): Promise<void> {
    this.ctl?.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    try {
      const n = await this.node(id, ctl.signal);
      if (ctl.signal.aborted) return;
      this.renderCrumbs(n);
    } catch (err) {
      if (!ctl.signal.aborted) console.warn('breadcrumb', err);
    } finally {
      if (this.ctl === ctl) this.ctl = null;
      this.scene.requestOverlay();
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
      b.addEventListener('click', () => void this.flyToNode(s.id));
      out.push(b);
    });
    return out;
  }

  /** Flies to a clade, framed at its rim (flyto.ts). */
  private async flyToNode(id: number): Promise<void> {
    const cam = this.scene.camera;
    let pose: Pose;
    const rot = this.scene.orient.baseRot;
    if (id === 0) {
      pose = wheelPose(cam, rot);
    } else {
      const n = await this.node(id);
      const [lo, hi] = arcRadians(n.arcLo, n.arcHi);
      pose = cladePose(cam, lo, hi, n.r, rot);
    }
    this.fly(pose);
  }

  private fly(pose: Pose): void {
    this.scene.input.cancel();
    this.scene.flight.fly(pose);
    this.scene.requestRender();
  }

  private buildControls(): void {
    const box = need('.zoom-controls', HTMLElement);
    const cam = this.scene.camera;
    const button = (icon: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement => {
      const b = el('button', { className: 'ctl', label, title: label });
      b.type = 'button';
      b.innerHTML =
        `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">` +
        `<path d="${ICONS[icon]}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>`;
      b.addEventListener('click', onClick);
      return b;
    };
    const zoom = (f: number) => (): void => {
      this.scene.flight.cancel();
      this.scene.input.zoomTo(cam.width / 2, cam.height / 2, f);
    };
    box.replaceChildren(
      button('minus', 'Zoom out', zoom(1 / ZOOM_STEP)),
      button('plus', 'Zoom in', zoom(ZOOM_STEP)),
      button('reset', 'Show the whole tree', () => this.fly(wheelPose(cam, this.scene.orient.baseRot))),
    );
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
      b.addEventListener('click', () => this.flyToGroup(g.id));
      items.push(el('li', {}, [b]));
    }
    ul.replaceChildren(...items);
  }

  private flyToGroup(group: number): void {
    let best: { lo: number; hi: number } | null = null;
    for (const run of this.meta.runs) {
      if (run.group !== group) continue;
      if (!best || run.angleHi - run.angleLo > best.hi - best.lo) best = { lo: run.angleLo, hi: run.angleHi };
    }
    if (!best) return;
    const [lo, hi] = arcRadians(best.lo, best.hi);
    this.fly(cladePose(this.scene.camera, lo, hi, 0.55, this.scene.orient.baseRot));
  }
}
