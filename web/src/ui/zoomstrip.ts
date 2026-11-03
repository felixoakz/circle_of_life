// The zoom strip (DESIGN.md §4.1, §4.3): a slim vertical scale on the left
// edge, like the side of a scroll wheel, that shows and sets the zoom. The
// top is maximum zoom (100%), the bottom the minimum, the composition a
// plain visit opens on (ZOOM_FLOOR %). In between the scale is logarithmic
// in zoom, so every step along it, and every wheel notch, feels the same:
//   t = (log2 scale − log2 min) / (log2 max − log2 min)      0 … 1
//   % = ZOOM_FLOOR + (100 − ZOOM_FLOOR) · t
// It replaces the − and + buttons; the reset button sits under it. A small
// "+" above the scale and "−" below it step it by a fifth (and say which end
// is which); the % reading shows only while the strip is hovered, focused
// or dragged.
//
// Drag the thumb or anywhere on the strip to zoom about the anchor (like
// the wheel); a click without dragging flies there; the mouse wheel over it
// zooms; it is a WAI-ARIA slider (↑/→ and ↓/← step 5%, Page Up/Down 20%,
// Home and End). It follows every other zoom (wheel, pinch, flights, the
// tour) each frame. As an input it stops the tour and the ambient turn
// (main.ts listens for pointer, wheel and keys on the whole page).
//
// It is an obstacle (ui/obstacles.ts): labels keep clear of it and the tree
// is darkened behind it, like the rest of the HUD.

import type { Box } from '../labelLayout';
import type { Layout } from '../layout';
import type { Scene } from '../scene';
import { elementBox, union } from './obstacles';

/** The reading at minimum zoom, %: low but not zero (the wheel is there, whole). */
export const ZOOM_FLOOR = 2;
/** Keyboard steps, % of the scale. */
const KEY_STEP = 5;
const PAGE_STEP = 20;
/** The strip's length on desktop: this share of the window's height (as much as fits on a phone). */
const LEN_SHARE = 2 / 3;
/** Never shorter than this, CSS px. */
const MIN_LEN = 80;
/** Wheel zoom over the strip, as on the canvas. */
const WHEEL_RATE = 0.0015;
/** A press that moves less than this (CSS px) is a click: fly there. */
const CLICK_SLOP = 4;
/**
 * Room under the scale for the "−" step and the reset button (28 px; 40 px
 * on a phone), and above the bottom HUD (breadcrumb, readout), CSS px. The
 * reset button's top is RESET_GAP under the scale.
 */
const RESET_ROOM = 60;
const COMPACT_RESET_ROOM = 76;
const RESET_GAP = 30;
const COMPACT_RESET_GAP = 34;
const BOTTOM_ROOM = 96;
/** Desktop: the scale's top at least this far down (under the header, the "+" above it). */
const TOP_ROOM = 72;
/** Tick spacing along the strip, CSS px, and a long tick every MAJOR_EVERY (calmer on the long scale). */
const TICK_PX = 8;
const MAJOR_EVERY = 5;
/** A phone's strip, CSS px from the left edge, and from the card's bottom (the "+" sits above it). */
const COMPACT_X = 20;
const COMPACT_TOP = 48;
/** The tree behind the strip darkens this much (lighter than the text's DIM_HUD: it is mostly ticks). */
const DIM_STRIP = 0.6;

/** Where `scale` sits on the scale, 0 (minimum zoom) to 1 (maximum), log scale. */
export function zoomFraction(scale: number, min: number, max: number): number {
  if (max <= min) return 1;
  const t = (Math.log2(scale) - Math.log2(min)) / (Math.log2(max) - Math.log2(min));
  return Math.min(1, Math.max(0, t));
}

/** The scale at fraction `t` of the scale. */
export function scaleAt(t: number, min: number, max: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 2 ** (Math.log2(min) + (Math.log2(max) - Math.log2(min)) * c);
}

/** The reading for fraction `t`, %. */
export function zoomPercent(t: number): number {
  return ZOOM_FLOOR + (100 - ZOOM_FLOOR) * Math.min(1, Math.max(0, t));
}

/** The fraction for a reading, %. */
export function percentFraction(p: number): number {
  return Math.min(1, Math.max(0, (p - ZOOM_FLOOR) / (100 - ZOOM_FLOOR)));
}

/**
 * Where the scale goes for a layout (CSS px; the "−" step and the reset
 * button sit in the RESET_ROOM under it): the left edge. Desktop: two thirds
 * of the window's height, centred on it, or as near the centre as the
 * header and the bottom HUD allow. Phone: all the room between the card and
 * the bottom HUD (two thirds of the height does not fit under the card).
 */
export function stripBox(l: Layout, h: number): Box {
  // A phone's strip stays a little further in, clear of the system's edge swipe.
  const x0 = l.compact ? COMPACT_X : 16;
  const x1 = x0 + 60;
  if (l.compact) {
    // Room above it for the "+" step, under the card.
    const top = l.card.y1 + COMPACT_TOP;
    const bottom = h - BOTTOM_ROOM - COMPACT_RESET_ROOM;
    const len = Math.max(MIN_LEN, Math.min(h * LEN_SHARE, bottom - top));
    return { x0, x1, y0: top, y1: top + len };
  }
  const bottom = h - BOTTOM_ROOM - RESET_ROOM;
  const len = Math.max(MIN_LEN, Math.min(h * LEN_SHARE, bottom - TOP_ROOM));
  const mid = Math.min(bottom - len / 2, Math.max(TOP_ROOM + len / 2, h / 2));
  return { x0, x1, y0: mid - len / 2, y1: mid + len / 2 };
}

const RESET_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M12.2 5.6A4.8 4.8 0 1 0 12.8 9M12.6 2.8v3h-3" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class ZoomStrip {
  private readonly scene: Scene;
  private readonly root: HTMLElement;
  private readonly track: HTMLElement;
  private readonly ticks: SVGSVGElement;
  private readonly thumb: HTMLElement;
  private readonly readout: HTMLElement;
  private shown = '';
  private len = 1;

  constructor(scene: Scene, root: HTMLElement, reset: () => void) {
    this.scene = scene;
    this.root = root;
    this.track = document.createElement('div');
    this.track.className = 'zoom-track';
    this.track.tabIndex = 0;
    this.track.setAttribute('role', 'slider');
    this.track.setAttribute('aria-label', 'Zoom');
    this.track.setAttribute('aria-orientation', 'vertical');
    this.track.setAttribute('aria-valuemin', String(ZOOM_FLOOR));
    this.track.setAttribute('aria-valuemax', '100');
    this.ticks = document.createElementNS(SVG_NS, 'svg');
    this.ticks.setAttribute('aria-hidden', 'true');
    this.ticks.classList.add('zoom-ticks');
    this.thumb = document.createElement('div');
    this.thumb.className = 'zoom-thumb';
    this.readout = document.createElement('span');
    this.readout.className = 'zoom-readout';
    this.readout.setAttribute('aria-hidden', 'true');
    this.track.append(this.ticks, this.thumb, this.readout);
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'ctl zoom-reset';
    resetButton.title = 'Zoom all the way out';
    resetButton.setAttribute('aria-label', 'Zoom all the way out');
    resetButton.innerHTML = RESET_ICON;
    resetButton.addEventListener('click', reset);
    // "+" above the scale, "−" below it: a fifth of the scale each.
    const step = (label: string, sign: 1 | -1): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = sign > 0 ? 'zoom-step zoom-in' : 'zoom-step zoom-out';
      b.textContent = label;
      b.title = sign > 0 ? 'Zoom in' : 'Zoom out';
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => this.stepBy(sign * PAGE_STEP, true));
      return b;
    };
    root.replaceChildren(step('+', 1), this.track, step('−', -1), resetButton);
    this.bind();
    scene.obstacles.set('zoom-strip', () => {
      // The strip with the buttons above and below it.
      const b = union(elementBox(this.root), ...[...this.root.children].map((c) => elementBox(c)));
      return b ? [{ box: b, keepClear: true, toEdge: false, dim: DIM_STRIP }] : [];
    });
  }

  /** Puts the strip on the left edge for a layout. */
  place(l: Layout, h: number): void {
    const b = stripBox(l, h);
    this.len = b.y1 - b.y0;
    const st = this.root.style;
    st.left = `${b.x0}px`;
    st.top = `${b.y0}px`;
    // The box holds the reading beside the scale and the reset button under it (it is the HUD obstacle).
    st.height = `${this.len + (l.compact ? COMPACT_RESET_ROOM : RESET_ROOM)}px`;
    this.track.style.height = `${this.len}px`;
    const out = this.root.querySelector<HTMLElement>('.zoom-out');
    if (out) out.style.top = `${this.len + 6}px`;
    const reset = this.root.querySelector<HTMLElement>('.zoom-reset');
    if (reset) reset.style.top = `${this.len + (l.compact ? COMPACT_RESET_GAP : RESET_GAP)}px`;
    this.root.classList.toggle('compact', l.compact);
    this.drawTicks();
    this.shown = '';
    this.frame();
    this.scene.obstacles.changed();
  }

  /** Called after every frame: follows the zoom, however it changed. */
  frame(): void {
    const rig = this.scene.rig;
    const t = zoomFraction(rig.scale, rig.minScale(), rig.maxScale());
    const pct = Math.round(zoomPercent(t));
    const y = (1 - t) * this.len;
    const key = `${pct}|${y.toFixed(1)}`;
    if (key === this.shown) return;
    this.shown = key;
    this.thumb.style.transform = `translateY(${y.toFixed(1)}px)`;
    this.readout.style.transform = `translateY(${y.toFixed(1)}px)`;
    this.readout.textContent = `${pct}%`;
    this.track.setAttribute('aria-valuenow', String(pct));
    this.track.setAttribute('aria-valuetext', t <= 0 ? `${pct}%, minimum zoom` : t >= 1 ? '100%, closest' : `${pct}%`);
  }

  /** Ticks every TICK_PX, a longer one every MAJOR_EVERY, like the side of a scroll wheel. */
  private drawTicks(): void {
    const n = Math.floor(this.len / TICK_PX);
    this.ticks.setAttribute('viewBox', `0 0 12 ${this.len}`);
    this.ticks.setAttribute('width', '12');
    this.ticks.setAttribute('height', String(this.len));
    const lines: SVGLineElement[] = [];
    for (let i = 0; i <= n; i++) {
      const y = Math.round(this.len - i * TICK_PX) + 0.5;
      const major = i % MAJOR_EVERY === 0;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', major ? '0' : '4');
      line.setAttribute('x2', '12');
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      line.setAttribute('class', major ? 'major' : 'minor');
      lines.push(line);
    }
    this.ticks.replaceChildren(...lines);
  }

  /** The fraction under a pointer's clientY. */
  private fractionAt(clientY: number): number {
    const r = this.track.getBoundingClientRect();
    return 1 - Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, r.height)));
  }

  /** Steps the reading by `pct` (the + and − buttons fly, keys cut). */
  private stepBy(pct: number, fly: boolean): void {
    const rig = this.scene.rig;
    const now = zoomPercent(zoomFraction(rig.scale, rig.minScale(), rig.maxScale()));
    this.zoomToFraction(percentFraction(now + pct), fly);
  }

  /** Zooms to fraction `t` about the anchor, at once (drag, keys) or by a flight (click). */
  private zoomToFraction(t: number, fly: boolean): void {
    const scene = this.scene;
    const rig = scene.rig;
    const scale = scaleAt(t, rig.minScale(), rig.maxScale());
    scene.input.cancel();
    if (fly) {
      scene.flight.fly({ theta: rig.theta, scale });
    } else {
      scene.flight.cancel();
      rig.set({ theta: rig.theta, scale });
    }
    scene.requestRender();
  }

  private bind(): void {
    let press: { y: number; moved: boolean } | null = null;
    this.track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.track.setPointerCapture(e.pointerId);
      press = { y: e.clientY, moved: false };
      this.root.classList.add('active');
      e.preventDefault();
      this.track.focus({ preventScroll: true });
    });
    this.track.addEventListener('pointermove', (e) => {
      if (!press) return;
      if (Math.abs(e.clientY - press.y) > CLICK_SLOP) press.moved = true;
      if (press.moved) this.zoomToFraction(this.fractionAt(e.clientY), false);
    });
    const end = (e: PointerEvent): void => {
      if (!press) return;
      const p = press;
      press = null;
      this.root.classList.remove('active');
      if (!p.moved && e.type === 'pointerup') this.zoomToFraction(this.fractionAt(e.clientY), true);
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
        this.scene.input.cancel();
        this.scene.flight.cancel();
        this.scene.rig.zoomBy(Math.exp(-e.deltaY * unit * WHEEL_RATE));
        this.scene.requestRender();
      },
      { passive: false },
    );
    this.track.addEventListener('keydown', (e) => {
      const rig = this.scene.rig;
      const t = zoomFraction(rig.scale, rig.minScale(), rig.maxScale());
      const pct = zoomPercent(t);
      let to: number | null = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') to = pct + KEY_STEP;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') to = pct - KEY_STEP;
      else if (e.key === 'PageUp') to = pct + PAGE_STEP;
      else if (e.key === 'PageDown') to = pct - PAGE_STEP;
      else if (e.key === 'Home') to = ZOOM_FLOOR;
      else if (e.key === 'End') to = 100;
      if (to === null) return;
      e.preventDefault();
      // The tree's own arrow keys (nav.ts) do not see this one.
      e.stopPropagation();
      this.zoomToFraction(percentFraction(to), false);
    });
  }
}
