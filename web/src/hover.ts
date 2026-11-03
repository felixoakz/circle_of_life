// Hover (DESIGN.md §5, §8; PLAN §7.8): the node under the mouse gets its
// root→node path drawn (2 px, text-1 at 60%), the rest of the tree dims to
// 60%, and a small tooltip shows its name and rank. Mouse only: touch has
// no hover (a tap selects, selection.ts).
//
// The path is drawn at once from the loaded tiles' parent links, as far up
// as they reach; ancestors' tiles are mostly not loaded (their arcs' centres
// are off screen), so after the pointer rests HOVER_FETCH_MS the node is
// fetched from /api/nodes (shared cache, nodes.ts) and the path completed
// to the root from its lineage. The same answer gives the tooltip its rank.

import { fromRad } from './angle';
import { type NodeStore } from './nodes';
import { type Pick, type TileIndex, pick } from './picking';
import { type PathPoint, encodePath, pathSegments, tilePoints } from './path';
import { nameRuns, nameSpans } from './names';
import type { Scene } from './scene';
import type { PathDraw } from './render/types';
import * as S from './style';
import { FLAG_HOME, FLAG_SPECIES, tileName } from './tiles/decode';
import type { Meta, NodeInfo } from './types';

const nf = new Intl.NumberFormat('en');

/** `--text-1` as linear-ish sRGB floats for the path colour. */
export const TEXT_1_RGB: readonly [number, number, number] = [0xe9 / 255, 0xe8 / 255, 0xe4 / 255];

/**
 * The tooltip's second line (DESIGN.md §8): "species · 1", "family · 3,214
 * species"; unranked clades just "3,214 species".
 */
export function rankLine(rank: string | null, leafCount: number): string {
  const word = rank && !rank.startsWith('no rank') ? rank : null;
  if (leafCount === 1 || word === 'species') return `${word ?? 'tip'} · ${nf.format(leafCount)}`;
  const count = `${nf.format(leafCount)} species`;
  return word ? `${word} · ${count}` : count;
}

/** The node under a screen point (device px), as drawn; `touch` widens the tolerance. */
export function pickAt(scene: Scene, meta: Meta, x: number, y: number, touch: boolean): Pick | null {
  const view = scene.lastView;
  if (!view) return null;
  const cam = scene.camera;
  const { theta, r } = cam.screenToPolar(x, y);
  const spacing = cam.tipSpacingPx() / cam.dpr;
  const px = cam.dpr;
  return pick(scene.lastTiles, {
    theta: fromRad(theta),
    rho: r,
    scale: cam.scale,
    level: view.level,
    tipCount: meta.tipCount,
    homeId: meta.home?.id ?? -1,
    homeAngle: meta.home?.angle ?? 0,
    tolPx: (touch ? S.PICK_TOL_TOUCH_PX : S.PICK_TOL_MOUSE_PX) * px,
    // Once tips resolve, the last stretch of each tip's line (its bar's length) picks the tip.
    rimInPx: (view.lambda > S.TIP_BAR_RAMP[0] ? S.TIP_BAR_MAX_LEN_PX : S.PICK_RIM_IN_PX) * px,
    // Over the names (readable or greeked), the name picks its tip.
    rimOutPx: (S.tipColumnAlpha(spacing) >= 0.5 ? S.PICK_LABEL_OUT_PX : S.PICK_RIM_OUT_PX) * px,
  });
}

/** Points of a fetched node's full path, and how far its last segment runs (tips and Homo sapiens reach the rim). */
export function nodePath(n: NodeInfo): { points: PathPoint[]; endR: number | undefined } {
  const points: PathPoint[] = n.lineage.map((a) => ({ angle: a.angle, r: a.r }));
  points.push({ angle: n.angle, r: n.r });
  const drawnAsTip = n.childCount === 0 || (n.flags & FLAG_HOME) !== 0;
  return { points, endR: drawnAsTip ? 1 : undefined };
}

interface Hovered {
  id: number;
  /** The node's line runs on to the rim on screen (a tip, Homo sapiens, or a frontier node whose children are not drawn). */
  reachRim: boolean;
  data: Uint32Array;
  /** The full path from the API is in (no more fetching). */
  complete: boolean;
}

export class Hover {
  private readonly scene: Scene;
  private readonly meta: Meta;
  private readonly store: NodeStore;
  private readonly index: TileIndex;
  private readonly tip: HTMLElement;
  private readonly tipName: HTMLElement;
  private readonly tipRank: HTMLElement;
  /** Mouse position, device px of the tree canvas, or null when outside. */
  private pointer: { x: number; y: number } | null = null;
  private moved = false;
  private lastKey = '';
  private current: Hovered | null = null;
  private fetchTimer = 0;
  private ctl: AbortController | null = null;
  /** The tree dim eases between 0 and HOVER_TREE_DIM. */
  private dimFrom = 0;
  private dimTo = 0;
  private dimT0 = 0;

  constructor(scene: Scene, meta: Meta, store: NodeStore, index: TileIndex, canvas: HTMLCanvasElement) {
    this.scene = scene;
    this.meta = meta;
    this.store = store;
    this.index = index;
    this.tipName = document.createElement('p');
    this.tipName.className = 'tooltip-name';
    this.tipRank = document.createElement('p');
    this.tipRank.className = 'tooltip-rank';
    this.tip = document.createElement('div');
    this.tip.className = 'tooltip';
    this.tip.setAttribute('aria-hidden', 'true');
    this.tip.hidden = true;
    this.tip.append(this.tipName, this.tipRank);
    document.body.append(this.tip);

    const toDevice = (e: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const k = canvas.width / Math.max(1, rect.width);
      return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
    };
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.pointer = toDevice(e);
      this.moved = true;
      scene.requestOverlay();
    });
    const leave = (): void => {
      this.pointer = null;
      this.moved = true;
      scene.requestOverlay();
    };
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') leave();
    });
  }

  /** The hovered node's id, or −1. */
  hoveredId(): number {
    return this.current?.id ?? -1;
  }

  /** Called after every frame: re-picks when the pointer, camera or tiles moved. */
  frame(now: number): void {
    const scene = this.scene;
    const cam = scene.camera;
    const key = `${cam.angle},${cam.r},${cam.scale},${cam.rot},${scene.lastTiles.length},${scene.lastView?.level}`;
    if (!this.moved && key === this.lastKey) return;
    this.moved = false;
    this.lastKey = key;
    this.index.update(scene.lastTiles);
    const busy = scene.input.dragging() || scene.flight.active() || scene.introPlaying();
    const p = this.pointer;
    const hit = p && !busy ? pickAt(scene, this.meta, p.x, p.y, false) : null;
    this.set(hit, now);
  }

  /** The hover path and tree dim for this frame; `animating` while the dim eases. */
  draw(now: number): { path: PathDraw | null; treeDim: number; animating: boolean } {
    const t = Math.min(1, (now - this.dimT0) / S.HOVER_FADE_MS);
    const treeDim = this.dimFrom + (this.dimTo - this.dimFrom) * t;
    const path = this.current
      ? { data: this.current.data, rgb: TEXT_1_RGB, alpha: S.HOVER_PATH_ALPHA, widthPx: S.PATH_WIDTH_PX }
      : null;
    return { path, treeDim, animating: t < 1 };
  }

  private set(hit: Pick | null, now: number): void {
    if (!hit) {
      if (this.current) {
        this.current = null;
        this.fade(0, now);
        this.cancelFetch();
        this.scene.requestRender();
      }
      this.tip.hidden = true;
      return;
    }
    this.placeTooltip();
    if (this.current?.id === hit.id) return;
    const homeId = this.meta.home?.id ?? -1;
    const homeAngle = this.meta.home?.angle ?? 0;
    const cached = this.store.peek(hit.id);
    // The path follows what is drawn: a node whose children are not drawn
    // yet has its line run on to the rim (its frontier extension), and
    // that is usually where the pointer found it.
    const rec = this.index.get(hit.id);
    const level = this.scene.lastView?.level ?? 0;
    const reachRim =
      !rec ||
      hit.id === homeId ||
      rec.index >= rec.tile.internalCount ||
      (rec.tile.childLevel[rec.index] ?? 255) > level;
    let data: Uint32Array;
    if (cached) {
      const { points } = nodePath(cached);
      data = encodePath(pathSegments(points, undefined, reachRim ? 1 : undefined));
    } else {
      const local = tilePoints(this.index, hit.id, homeId, homeAngle);
      data = local ? encodePath(pathSegments(local.points, local.startR, reachRim ? 1 : undefined)) : new Uint32Array();
    }
    this.current = { id: hit.id, reachRim, data, complete: cached !== undefined };
    this.fade(S.HOVER_TREE_DIM, now);
    this.fillTooltip(hit, cached ?? null);
    this.scene.requestRender();
    if (!cached) this.scheduleFetch(hit.id);
  }

  private fade(to: number, now: number): void {
    if (to === this.dimTo) return;
    const t = Math.min(1, (now - this.dimT0) / S.HOVER_FADE_MS);
    this.dimFrom = this.dimFrom + (this.dimTo - this.dimFrom) * t;
    this.dimTo = to;
    this.dimT0 = now;
    // The label overlay dims with the tree (styles.css, `.hovering`).
    document.documentElement.classList.toggle('hovering', to > 0);
  }

  private scheduleFetch(id: number): void {
    this.cancelFetch();
    this.fetchTimer = window.setTimeout(() => {
      this.fetchTimer = 0;
      const ctl = new AbortController();
      this.ctl = ctl;
      this.store
        .get(id, ctl.signal)
        .then((n) => {
          const cur = this.current;
          if (ctl.signal.aborted || cur?.id !== id) return;
          const { points, endR } = nodePath(n);
          const data = encodePath(pathSegments(points, undefined, cur.reachRim ? 1 : endR));
          this.current = { ...cur, data, complete: true };
          this.fillTooltipFrom(n);
          this.scene.requestRender();
        })
        .catch((err: unknown) => {
          if (!ctl.signal.aborted) console.warn('hover', err);
        })
        .finally(() => {
          if (this.ctl === ctl) this.ctl = null;
        });
    }, S.HOVER_FETCH_MS);
  }

  private cancelFetch(): void {
    window.clearTimeout(this.fetchTimer);
    this.fetchTimer = 0;
    this.ctl?.abort();
    this.ctl = null;
  }

  /** Tooltip text from the tile (the rank follows from the API when it is not a species). */
  private fillTooltip(hit: Pick, info: NodeInfo | null): void {
    if (info) {
      this.fillTooltipFrom(info);
      return;
    }
    // A merged Homo sapiens subspecies tip stands for the species node.
    const rec = this.index.get(hit.id) ?? { tile: hit.tile, index: hit.index };
    const { tile, index: i } = rec;
    const name = tileName(tile, i);
    const flags = tile.flags[i] ?? 0;
    const leafCount = tile.leafCount[i] ?? 1;
    const rank = flags & FLAG_SPECIES ? 'species' : null;
    this.setTooltip(name, rank, leafCount, rank !== null || leafCount === 1);
  }

  private fillTooltipFrom(n: NodeInfo): void {
    this.setTooltip(n.name ?? '', n.rank, n.leafCount, true);
  }

  private setTooltip(name: string, rank: string | null, leafCount: number, rankKnown: boolean): void {
    if (name) {
      this.tipName.replaceChildren(...nameSpans(nameRuns(name, rank)));
    } else {
      this.tipName.textContent = 'Unnamed clade';
    }
    this.tipRank.textContent = rankKnown ? rankLine(rank, leafCount) : rankLine(null, leafCount);
    this.tip.hidden = false;
    this.placeTooltip();
  }

  /** Puts the tooltip TOOLTIP_OFFSET_PX below-right of the pointer, flipped at the window's edges. */
  private placeTooltip(): void {
    const p = this.pointer;
    if (!p || this.tip.hidden) return;
    const dpr = this.scene.camera.dpr;
    const x = p.x / dpr;
    const y = p.y / dpr;
    const off = S.TOOLTIP_OFFSET_PX;
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    const left = x + off + w > window.innerWidth - S.GUTTER_PX ? x - off - w : x + off;
    const top = y + off + h > window.innerHeight - S.GUTTER_PX ? y - off - h : y + off;
    this.tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}
