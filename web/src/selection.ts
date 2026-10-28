// Selection (DESIGN.md §5, §8; PLAN §7.10, §7.11): one selected node at a
// time, shown three ways:
//   - on the canvas, a white 2 px root→node path and a hairline ring;
//   - in the panel (ui/panel.ts);
//   - in the URL: `?n=<OpenTree id>`, pushed on every selection so Back and
//     Forward step through them, and `v=` (the camera), replaced 300 ms
//     after the camera settles.
// A click or tap selects and flies to the node; the flight leaves room for
// the panel, so the selection is not hidden behind it. With a selection,
// ↑ / Backspace, ↓, ← / → walk the tree (nav.ts) and Esc closes. Each
// selection is announced through the aria-live region.

import { fetchAbout } from './api';
import { TAU, toRad } from './angle';
import type { Camera } from './camera';
import { type Pose, arcRadians, cladePose, wheelPose } from './flyto';
import { nodePath, rankLine } from './hover';
import { navMove, navTarget } from './nav';
import type { NodeStore } from './nodes';
import { encodePath, pathSegments } from './path';
import type { PathDraw, RingDraw } from './gl/renderer';
import type { Scene } from './scene';
import * as S from './style';
import { FLAG_HOME } from './tiles/decode';
import type { Meta, NodeInfo } from './types';
import { Panel } from './ui/panel';
import { type DeepLink, linkSearch, parseLink, viewOf } from './url';

/** The URL's camera is rewritten this long after the camera stops (PLAN §7.11). */
const URL_DEBOUNCE_MS = 300;
const WHITE: readonly [number, number, number] = [1, 1, 1];
/** Share of the screen's shorter side the view moves outward for the tip-label column. */
const LABEL_ROOM = 0.2;

type History = 'push' | 'replace' | 'none';

export interface SelectOptions {
  /** Fly the camera to the node. */
  fly: boolean;
  history: History;
}

/**
 * Moves a pose's centre so its target lands in the middle of the part of
 * the screen the panel leaves free: `inset` (CSS px) is covered on the right
 * (desktop panel) or at the bottom (mobile sheet). `rot` is the rotation the
 * view will have when the flight ends.
 */
export function insetPose(pose: Pose, inset: { right: number; bottom: number }, dpr: number, rot: number): Pose {
  // The target should sit (right/2, bottom/2) px up-left of the screen
  // centre, so the centre is that far down-right of the target.
  const dx = (inset.right / 2) * dpr;
  const dy = (inset.bottom / 2) * dpr;
  const sx = dx / pose.scale;
  const sy = -dy / pose.scale;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { ...pose, x: pose.x + sx * cos + sy * sin, y: pose.y - sx * sin + sy * cos };
}

/**
 * The pose framing a node: its clade at the rim, or the whole wheel for the
 * root. Where tips are labelled, the view moves outward by LABEL_ROOM of the
 * screen so the label column beyond the rim fits (on a phone the rim would
 * otherwise sit mid-screen and cut the names).
 */
export function nodePose(cam: Camera, n: NodeInfo, baseRot: number, tipCount: number): Pose {
  if (n.lineage.length === 0) return wheelPose(cam, baseRot);
  // Half a tip slot either side, so a tip or a small clade is framed with its bars.
  const half = 2 ** 31 / tipCount;
  const [lo, hi] = arcRadians(n.arcLo - half, n.arcHi + half);
  const pose = cladePose(cam, lo, hi, n.r, baseRot);
  const spacing = (pose.scale * TAU) / tipCount / cam.dpr;
  if (spacing < S.TIP_LABEL_SPACING) return pose;
  const out = (LABEL_ROOM * Math.min(cam.width, cam.height)) / pose.scale;
  const len = Math.hypot(pose.x, pose.y) || 1;
  return { ...pose, x: pose.x + (pose.x / len) * out, y: pose.y + (pose.y / len) * out };
}

/** The selection's ring sits at the node's point; Homo sapiens is drawn as a tip, so its ring is at the rim. */
export function ringPoint(n: NodeInfo): { angle: number; r: number } {
  const tipLike = n.childCount === 0 || (n.flags & FLAG_HOME) !== 0;
  return { angle: n.angle, r: tipLike ? 1 : n.r };
}

/** "Felidae, family · 47 species" for the live region. */
export function announcement(n: NodeInfo): string {
  const name = n.name ?? 'Unnamed clade';
  return `Selected ${name}, ${rankLine(n.rank, n.leafCount)}`;
}

export class Selection {
  readonly panel: Panel;
  private readonly scene: Scene;
  private readonly meta: Meta;
  private readonly store: NodeStore;
  private readonly announcer: HTMLElement;
  private node: NodeInfo | null = null;
  private draws: { path: PathDraw; ring: RingDraw } | null = null;
  private ctl: AbortController | null = null;
  private loadingId: number | string | null = null;
  private urlTimer = 0;
  private camKey = '';
  /** The URL had a camera, or the camera has moved since load: keep `v` in it. */
  private trackView = false;

  constructor(
    scene: Scene,
    meta: Meta,
    store: NodeStore,
    panelRoot: HTMLElement,
    announcer: HTMLElement,
    credits: () => void,
  ) {
    this.scene = scene;
    this.meta = meta;
    this.store = store;
    this.announcer = announcer;
    this.panel = new Panel(panelRoot, scene.obstacles, meta.dataVersion, {
      select: (id) => void this.select(id, { fly: true, history: 'push' }),
      close: () => this.clear('push'),
      node: (ref) => store.get(ref),
      moved: () => scene.requestRender(),
      about: (ref, retry, signal) => fetchAbout(ref, retry, signal),
      credits,
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('popstate', () => this.onPopState());
    scene.input.arrowsPan = () => this.node === null;
    this.trackView = parseLink(location.search).v !== null;
  }

  selected(): NodeInfo | null {
    return this.node;
  }

  /** True while a selection is loading (the scene is not idle yet). */
  busy(): boolean {
    return this.ctl !== null || this.panel.busy();
  }

  /** The selection's path and ring for this frame. */
  draw(): { path: PathDraw; ring: RingDraw } | null {
    return this.draws;
  }

  /** Selects a node by pre-order id or OpenTree id. */
  async select(ref: number | string, opts: SelectOptions): Promise<void> {
    if (this.node && (this.node.id === ref || this.node.nodeId === ref)) {
      if (opts.fly) this.flyTo(this.node);
      return;
    }
    this.ctl?.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    this.loadingId = ref;
    this.panel.loading(true);
    this.scene.requestOverlay();
    try {
      const n = await this.store.get(ref, ctl.signal);
      if (ctl.signal.aborted) return;
      this.apply(n, opts.history !== 'none');
      if (opts.history !== 'none') this.writeUrl(opts.history);
      if (opts.fly) this.flyTo(n);
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.warn('select', err);
      this.panel.showError(() => void this.select(ref, opts));
    } finally {
      if (this.ctl === ctl) {
        this.ctl = null;
        this.loadingId = null;
        this.panel.loading(false);
        this.scene.requestOverlay();
      }
    }
  }

  /** Clears the selection and closes the panel. */
  clear(history: History): void {
    this.ctl?.abort();
    this.ctl = null;
    this.panel.loading(false);
    if (!this.node && !this.panel.isOpen()) return;
    this.node = null;
    this.draws = null;
    this.panel.hide();
    this.announcer.textContent = 'Selection cleared';
    if (history !== 'none') this.writeUrl(history);
    this.scene.requestRender();
  }

  /** Called after every frame: keeps the URL's camera in step, 300 ms after it settles. */
  frame(): void {
    const cam = this.scene.camera;
    const key = `${cam.angle},${cam.r},${cam.scale},${cam.rot}`;
    if (key === this.camKey) return;
    const first = this.camKey === '';
    this.camKey = key;
    if (first) return;
    this.trackView = true;
    window.clearTimeout(this.urlTimer);
    this.urlTimer = window.setTimeout(() => {
      this.urlTimer = 0;
      if (!this.scene.flight.active() && !this.scene.input.dragging()) this.writeUrl('replace');
      else this.camKey = ''; // still moving: try again on the next frame
    }, URL_DEBOUNCE_MS);
  }

  private apply(n: NodeInfo, focus: boolean): void {
    this.node = n;
    const { points, endR } = nodePath(n);
    const ring = ringPoint(n);
    this.draws = {
      path: { data: encodePath(pathSegments(points, undefined, endR)), rgb: WHITE, alpha: 1, widthPx: S.PATH_WIDTH_PX },
      ring: { ...ring, rgb: WHITE, alpha: 1, radiusPx: S.SELECT_RING_PX },
    };
    this.panel.show(n, focus);
    this.announcer.textContent = announcement(n);
    this.scene.requestRender();
  }

  private link(): DeepLink {
    return { n: this.node?.nodeId ?? null, v: this.trackView ? viewOf(this.scene.camera) : null };
  }

  private writeUrl(mode: 'push' | 'replace'): void {
    const search = linkSearch(location.search, this.link());
    if (search === location.search && mode === 'replace') return;
    const url = `${location.pathname}${search}${location.hash}`;
    if (mode === 'push') history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  /** Flies to a node, leaving room for the panel. */
  private flyTo(n: NodeInfo): void {
    const scene = this.scene;
    const cam = scene.camera;
    const base = scene.orient.baseRot;
    let pose = nodePose(cam, n, base, this.meta.tipCount);
    // The rotation the view will have on arrival (auto-orient's rule: the
    // rim turned vertical once tips are apart, the base rotation when zoomed
    // out), so the room left for the panel is measured on the final screen.
    const rot = scene.orient.rotationFor(pose);
    if (this.panel.isOpen()) pose = insetPose(pose, this.panel.inset(), cam.dpr, rot);
    scene.input.cancel();
    scene.flight.fly(pose);
    scene.requestRender();
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A modal dialog (Data & credits) handles its own keys, Esc included.
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      if (this.node || this.panel.isOpen()) {
        this.clear('push');
        e.preventDefault();
      }
      return;
    }
    const move = navMove(e.key);
    const node = this.node;
    if (!move || !node) return;
    // Buttons and links keep their own keys (Space/Enter); arrows walk the tree.
    e.preventDefault();
    void this.navigate(move, node);
  }

  private async navigate(move: ReturnType<typeof navMove>, node: NodeInfo): Promise<void> {
    if (!move) return;
    let parent: NodeInfo | null = null;
    if (move === 'prev' || move === 'next') {
      const pid = node.lineage[node.lineage.length - 1]?.id;
      if (pid === undefined) return;
      try {
        parent = await this.store.get(pid);
      } catch (err) {
        console.warn('siblings', err);
        return;
      }
    }
    const target = navTarget(move, node, parent);
    if (target === null) {
      this.announcer.textContent =
        move === 'parent' ? 'This is the root' : move === 'child' ? 'No children: this is a tip' : 'No siblings';
      return;
    }
    if (this.node !== node || this.loadingId !== null) return;
    await this.select(target, { fly: true, history: 'push' });
  }

  /** Back / Forward: restore that entry's selection and camera. */
  private onPopState(): void {
    const link = parseLink(location.search);
    const view = link.v;
    if (view) {
      const cam = this.scene.camera;
      const a = toRad(view.a);
      this.scene.input.cancel();
      this.scene.flight.fly({ x: view.r * Math.cos(a), y: view.r * Math.sin(a), scale: 2 ** view.z * cam.dpr });
      this.scene.requestRender();
    }
    if (!link.n) this.clear('none');
    else void this.select(link.n, { fly: !view, history: 'none' });
  }
}
