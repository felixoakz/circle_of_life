// Selection (DESIGN.md §4, §5, §8; PLAN §7.10, §7.11): there is always
// exactly one selected node, a species or a clade, Homo sapiens to begin
// with. It is shown four ways:
//   - on the canvas, a white 2 px root→node path and a hairline ring;
//   - in the card (ui/panel.ts), fixed at the top right (the top on a phone);
//   - by the leader, a hairline from the node to the card (callout.ts);
//   - in the URL: `?n=<OpenTree id>`, pushed on every selection so Back and
//     Forward step through them, and `v=` (the view), replaced 300 ms after
//     it settles.
// A click or tap selects and turns the wheel so the node lands on the anchor
// (rig.ts), keeping the zoom. Search, the lineage, the breadcrumb, the
// kingdom key and the keys fly there: turn and zoom to suit the node. With
// ↑ / Backspace, ↓, ← / → the keys walk the tree (nav.ts). Each selection is
// announced through the aria-live region. Nothing clears the selection.

import { fetchAbout } from './api';
import { TAU, toRad } from './angle';
import type { Point } from './camera';
import { nodePath, rankLine } from './hover';
import { navMove, navTarget } from './nav';
import type { NodeStore } from './nodes';
import { encodePath, pathSegments } from './path';
import type { PathDraw, RingDraw } from './render/types';
import type { Pose, Rig } from './rig';
import type { Scene } from './scene';
import * as S from './style';
import { FLAG_HOME } from './tiles/decode';
import type { Meta, NodeInfo } from './types';
import { Panel } from './ui/panel';
import { type DeepLink, linkSearch, parseLink, viewOf, viewPose } from './url';

/** The URL's view is rewritten this long after the view stops (PLAN §7.11). */
const URL_DEBOUNCE_MS = 300;
const WHITE: readonly [number, number, number] = [1, 1, 1];
/** Zoom to suit: the node's tips fill this share of the screen's height… */
const SUIT_FILL = 0.6;
/** …but never fewer than this many tips (so a species shows its neighbours and their names). */
const SUIT_MIN_TIPS = 24;
/** A clade whose tips would be at least this far apart (CSS px) zooms on until their names show… */
const SUIT_NAMES_FROM = 3;
/** …at this spacing (tip names show from S.TIP_LABEL_SPACING). */
const SUIT_NAMES_SPACING = 14;

type History = 'push' | 'replace' | 'none';

/**
 * What the view does on selection:
 *   turn  the node turns onto the anchor, zoom kept (a click);
 *   fly   turn and zoom to suit the node (search, lineage, keys);
 *   cut   the same pose as `fly`, at once (a deep link without a view);
 *   none  the view stays (a link with a view, Back and Forward);
 *   tour  the idle tour (tour.ts): turn onto the anchor at the same zoom,
 *         along a fly-to path (it zooms out on the way when far), slowly.
 */
export type Motion = 'turn' | 'fly' | 'cut' | 'none' | 'tour';

export interface SelectOptions {
  motion: Motion;
  history: History;
  /** Announce it through the live region (default true; the tour stays quiet). */
  announce?: boolean;
}

/** A tour step's minimum flight time, ms (a calm turn even between neighbours). */
const TOUR_FLIGHT_MS = 2400;

/**
 * The zoom that suits a node, device px per world unit: its tips (leafCount
 * slots, at least SUIT_MIN_TIPS) fill SUIT_FILL of `span` along the rim,
 * through the anchor; the clade's depth runs inward from there, where the
 * screen has room. A small clade (tips SUIT_NAMES_FROM px apart or more)
 * zooms on to SUIT_NAMES_SPACING so its names show. The root and other huge
 * clades come out below the minimum zoom (the rig clamps it). (`arcLo` and
 * `arcHi` are the node's connector between its children, not its tips.)
 */
export function suitScale(n: NodeInfo, tipCount: number, span: number, dpr: number): number {
  const tips = Math.max(n.leafCount, SUIT_MIN_TIPS);
  let spacing = (SUIT_FILL * span) / tips / dpr;
  if (spacing >= SUIT_NAMES_FROM) spacing = Math.max(spacing, SUIT_NAMES_SPACING);
  return (spacing * dpr * tipCount) / TAU;
}

/** The pose that puts `n` on the anchor at its suiting zoom. */
export function suitPose(rig: Rig, n: NodeInfo, tipCount: number): Pose {
  const cam = rig.camera;
  // The height: once tips resolve, the rim runs up and down the screen at the anchor.
  return { theta: toRad(n.angle), scale: rig.clampScale(suitScale(n, tipCount, cam.height, cam.dpr)) };
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
  private viewKey = '';
  /** The URL had a view, or the view has moved since load: keep `v` in it. */
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
      select: (id) => void this.select(id, { motion: 'fly', history: 'push' }),
      node: (ref) => store.get(ref),
      moved: () => scene.requestRender(),
      about: (ref, retry, signal) => fetchAbout(ref, retry, signal),
      credits,
      home: (n) => (n.flags & FLAG_HOME) !== 0,
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('popstate', () => this.onPopState());
    this.trackView = parseLink(location.search).v !== null;
  }

  /** The node selected when the URL names none: Homo sapiens, or the root on a tree without it. */
  defaultRef(): number | string {
    return this.meta.home?.nodeId ?? 0;
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

  /**
   * The selection's stem on screen, CSS px, for the leader (callout.ts):
   * from its ring (`node`) straight out to the rim at its angle (`rim`; the
   * same point for a tip), the outward unit vector there, and whether it is
   * drawn as a tip (its name sits on the row beyond the rim). Points may be
   * far off screen.
   */
  leaderTarget(): { n: NodeInfo; node: Point; rim: Point; out: Point; tip: boolean } | null {
    const n = this.node;
    if (!n) return null;
    const cam = this.scene.camera;
    const dpr = cam.dpr;
    const ring = ringPoint(n);
    const theta = toRad(ring.angle);
    const a = cam.polarToScreen(theta, ring.r);
    const b = cam.polarToScreen(theta, 1);
    const c = cam.polarToScreen(theta, 1 + 1 / cam.scale);
    const len = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    return {
      n,
      node: { x: a.x / dpr, y: a.y / dpr },
      rim: { x: b.x / dpr, y: b.y / dpr },
      out: { x: (c.x - b.x) / len, y: (c.y - b.y) / len },
      tip: ring.r === 1,
    };
  }

  /** Selects a node by pre-order id or OpenTree id. */
  async select(ref: number | string, opts: SelectOptions): Promise<void> {
    if (this.node && (this.node.id === ref || this.node.nodeId === ref)) {
      this.move(this.node, opts.motion);
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
      this.apply(n, opts.history !== 'none' && opts.motion !== 'tour', opts.announce ?? true);
      if (opts.history !== 'none') this.writeUrl(opts.history);
      this.move(n, opts.motion);
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

  /** Called after every frame: keeps the URL's view in step, 300 ms after it settles. */
  frame(): void {
    const rig = this.scene.rig;
    const key = `${rig.theta},${rig.scale}`;
    if (key === this.viewKey) return;
    const first = this.viewKey === '';
    this.viewKey = key;
    if (first) return;
    this.trackView = true;
    window.clearTimeout(this.urlTimer);
    this.urlTimer = window.setTimeout(() => {
      this.urlTimer = 0;
      if (!this.scene.flight.active() && !this.scene.input.dragging() && !this.scene.input.animating()) {
        this.writeUrl('replace');
      } else {
        this.viewKey = ''; // still moving: try again on the next frame
      }
    }, URL_DEBOUNCE_MS);
  }

  private apply(n: NodeInfo, focus: boolean, announce: boolean): void {
    this.node = n;
    const { points, endR } = nodePath(n);
    const ring = ringPoint(n);
    this.draws = {
      path: { data: encodePath(pathSegments(points, undefined, endR)), rgb: WHITE, alpha: 1, widthPx: S.PATH_WIDTH_PX },
      ring: { ...ring, rgb: WHITE, alpha: 1, radiusPx: S.SELECT_RING_PX },
    };
    this.panel.show(n, focus);
    if (announce) this.announcer.textContent = announcement(n);
    this.scene.requestRender();
  }

  private link(): DeepLink {
    const rig = this.scene.rig;
    return { n: this.node?.nodeId ?? null, v: this.trackView ? viewOf(rig.pose(), rig.camera.dpr) : null };
  }

  private writeUrl(mode: 'push' | 'replace'): void {
    const search = linkSearch(location.search, this.link());
    if (search === location.search && mode === 'replace') return;
    const url = `${location.pathname}${search}${location.hash}`;
    if (mode === 'push') history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  /** Moves the view for a selection (see Motion). */
  private move(n: NodeInfo, motion: Motion): void {
    if (motion === 'none') return;
    const scene = this.scene;
    const rig = scene.rig;
    scene.input.cancel();
    if (motion === 'turn') {
      scene.flight.fly({ theta: toRad(n.angle), scale: rig.scale }, { turnOnly: true });
    } else if (motion === 'fly') {
      scene.flight.fly(suitPose(rig, n, this.meta.tipCount));
    } else if (motion === 'tour') {
      scene.flight.fly({ theta: toRad(n.angle), scale: rig.scale }, { minMs: TOUR_FLIGHT_MS });
    } else {
      scene.flight.cancel();
      rig.set(suitPose(rig, n, this.meta.tipCount));
    }
    scene.requestRender();
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
    // A slider (the zoom strip) keeps its own arrow keys.
    if (t instanceof HTMLElement && t.getAttribute('role') === 'slider') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A modal dialog (Data & credits) handles its own keys.
    if (document.querySelector('dialog[open]')) return;
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
    await this.select(target, { motion: 'fly', history: 'push' });
  }

  /** Back / Forward: restore that entry's selection and view. */
  private onPopState(): void {
    const link = parseLink(location.search);
    const view = link.v;
    const rig = this.scene.rig;
    if (view) {
      this.scene.input.cancel();
      this.scene.flight.fly(viewPose(view, rig.camera.dpr));
      this.scene.requestRender();
    }
    void this.select(link.n ?? this.defaultRef(), { motion: view ? 'none' : 'fly', history: 'none' });
  }
}
