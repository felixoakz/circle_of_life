// Pointer, wheel, pinch and keyboard → the rig (ARCHITECTURE §7.5, DESIGN.md §8).
// There is no pan: the view is a rotation and a zoom (rig.ts).
//
//   drag          turns the wheel about its centre (the point under the
//                 pointer follows it round); a release flings it (spin.ts)
//   wheel, + / −  zoom about the anchor
//   double-click  zooms in ×2 about the anchor
//   pinch         zooms by the change in finger distance; twisting the two
//                 fingers turns the wheel by the change in their angle (and
//                 flings it too)
//   tap / click   selects (onTap; selection.ts)
//
// In free view (rig.ts, freeview.ts) the same gestures pan instead:
//
//   drag          pans: the point under the pointer stays under it (no fling)
//   shift + drag  turns the picture about the point where the drag began
//   wheel         zooms about the cursor; double-click ×2 about it
//   + / −         zoom about the screen centre
//   pinch         zooms about the fingers' midpoint, pans with it and turns
//                 by the twist, about it
//
// All positions are device pixels relative to the canvas, like the camera.

import type { Rig } from './rig';

/** Wheel zoom: scale ×= exp(−dy · WHEEL_RATE), dy in px. */
const WHEEL_RATE = 0.0015;
const ZOOM_TWEEN_MS = 220;
const KEY_ZOOM = 1.5;
/** A press that moves less than this (CSS px) and lifts within TAP_MS is a tap (select), not a drag. */
const TAP_SLOP_PX = 6;
const TAP_MS = 500;
/** Free view's shift + drag: radians per CSS px of horizontal travel (dragging right turns clockwise). */
const SHIFT_TURN_PER_PX = 0.005;

interface Ptr {
  x: number;
  y: number;
}

interface ZoomTween {
  from: number; // log2 scale
  to: number;
  t0: number;
  /** Free view: the screen point it zooms about (null: the anchor, or the screen centre). */
  at: Ptr | null;
}

export class Input {
  /** Set by ?reduced or prefers-reduced-motion: no inertia, zooms are cuts. */
  reducedMotion = false;
  /** Called on any user input that moves the view (cancels a flight). */
  onUserInput: () => void = () => {};
  /** Called when a drag (one or more pointers down) starts and ends. */
  onDrag: (dragging: boolean) => void = () => {};
  /** Called for a tap or click that did not drag: device px, and whether it was a finger or pen. */
  onTap: (x: number, y: number, touch: boolean) => void = () => {};
  /** Called when a turning drag or twist is released moving: its angular velocity, rad/ms (spin.ts). */
  onFling: (v: number) => void = () => {};

  private readonly canvas: HTMLCanvasElement;
  private readonly rig: Rig;
  private readonly onChange: () => void;
  private readonly pointers = new Map<number, Ptr>();
  /** Angular velocity of the drag or twist, radians per ms, smoothed. */
  private velocity = 0;
  private lastMoveT = 0;
  private tween: ZoomTween | null = null;
  /** The press that may become a tap: where and when it started, and whether it stayed put. */
  private press: { x: number; y: number; t: number; still: boolean; touch: boolean } | null = null;
  /** Free view: the point a shift + drag turns about, while shift is held. */
  private pivot: Ptr | null = null;

  constructor(canvas: HTMLCanvasElement, rig: Rig, onChange: () => void) {
    this.canvas = canvas;
    this.rig = rig;
    this.onChange = onChange;
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => {
      this.onUserInput();
      this.zoomTo(2, this.rig.isFree() ? this.pos(e) : null);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** True while one or more pointers are down. */
  dragging(): boolean {
    return this.pointers.size > 0;
  }

  /** True while a zoom tween still moves the view. */
  animating(): boolean {
    return this.tween !== null;
  }

  /** Advances the zoom tween to time `now`; called once per frame. */
  step(now: number): void {
    if (this.tween) {
      const tw = this.tween;
      const t = Math.min(1, (now - tw.t0) / ZOOM_TWEEN_MS);
      const e = 1 - (1 - t) ** 3; // ease-out cubic
      const scale = 2 ** (tw.from + (tw.to - tw.from) * e);
      if (tw.at) this.rig.setScale(scale, tw.at);
      else this.rig.setScale(scale);
      if (t >= 1) this.tween = null;
    }
  }

  /** Stops the zoom tween (any new input does). */
  cancel(): void {
    this.tween = null;
  }

  /**
   * Zooms by `factor`, animated unless reduced motion: about the anchor, or
   * in free view about `at` (device px; default the screen centre).
   */
  zoomTo(factor: number, at: Ptr | null = null): void {
    this.cancel();
    if (this.reducedMotion) {
      if (at) this.rig.zoomAt(factor, at);
      else this.rig.zoomBy(factor);
    } else {
      const from = Math.log2(this.rig.scale);
      const to = Math.log2(this.rig.clampScale(this.rig.scale * factor));
      this.tween = { from, to, t0: performance.now(), at };
    }
    this.onChange();
  }

  private pos(e: MouseEvent): Ptr {
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / Math.max(1, rect.width);
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.cancel();
    this.onUserInput();
    // deltaMode: 0 pixels, 1 lines, 2 pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    // About the anchor; in free view about the cursor.
    this.rig.zoomAt(Math.exp(-e.deltaY * unit * WHEEL_RATE), this.pos(e));
    this.onChange();
  }

  private onPointerDown(e: PointerEvent): void {
    this.cancel();
    this.onUserInput();
    if (this.pointers.size === 0) this.onDrag(true);
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.press =
      this.pointers.size === 0 && e.button === 0
        ? { x: p.x, y: p.y, t: e.timeStamp, still: true, touch: e.pointerType !== 'mouse' }
        : null;
    this.pointers.set(e.pointerId, p);
    this.pivot = null;
    this.velocity = 0;
    this.lastMoveT = e.timeStamp;
  }

  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.pos(e);
    const press = this.press;
    if (press && Math.hypot(p.x - press.x, p.y - press.y) > TAP_SLOP_PX * this.rig.camera.dpr) press.still = false;
    if (this.rig.isFree()) {
      this.freeMove(e, prev, p);
    } else if (this.pointers.size === 1) {
      // The point under the pointer follows it round the wheel's centre.
      const turn = this.rig.sweep(prev, p);
      this.rig.rotateBy(turn);
      const dt = Math.max(1, e.timeStamp - this.lastMoveT);
      // Exponentially smoothed velocity, so one jittery sample cannot fling.
      this.velocity = 0.6 * (turn / dt) + 0.4 * this.velocity;
      this.lastMoveT = e.timeStamp;
    } else if (this.pointers.size === 2) {
      // Pinch: zoom by the change in finger distance (about the anchor), and
      // turn by the change in the fingers' angle.
      let other: Ptr | undefined;
      for (const [id, q] of this.pointers) if (id !== e.pointerId) other = q;
      if (!other) return;
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(p.x - other.x, p.y - other.y);
      if (d0 > 0) this.rig.zoomBy(d1 / d0);
      const twist = twistAngle(prev, p, other);
      if (d0 > 0 && d1 > 0) {
        this.rig.rotateBy(twist);
        const dt = Math.max(1, e.timeStamp - this.lastMoveT);
        this.velocity = 0.6 * (twist / dt) + 0.4 * this.velocity;
        this.lastMoveT = e.timeStamp;
      }
    }
    this.pointers.set(e.pointerId, p);
    this.onChange();
  }

  /** Free view: a drag pans (shift + drag turns about where it began), two fingers pinch, pan and twist. */
  private freeMove(e: PointerEvent, prev: Ptr, p: Ptr): void {
    const rig = this.rig;
    if (this.pointers.size === 1) {
      if (!e.shiftKey) {
        this.pivot = null;
        rig.panBy(p.x - prev.x, p.y - prev.y);
        return;
      }
      this.pivot ??= { ...prev };
      rig.rotateAt((-(p.x - prev.x) / rig.camera.dpr) * SHIFT_TURN_PER_PX, this.pivot);
      return;
    }
    if (this.pointers.size !== 2) return;
    let other: Ptr | undefined;
    for (const [id, q] of this.pointers) if (id !== e.pointerId) other = q;
    if (!other) return;
    const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
    const m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
    const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
    const d1 = Math.hypot(p.x - other.x, p.y - other.y);
    rig.panBy(m1.x - m0.x, m1.y - m0.y);
    if (d0 > 0 && d1 > 0) {
      rig.zoomAt(d1 / d0, m1);
      rig.rotateAt(twistAngle(prev, p, other), m1);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size === 0) this.onDrag(false);
    const press = this.press;
    this.press = null;
    if (e.type === 'pointerup' && press?.still && this.pointers.size === 0 && e.timeStamp - press.t < TAP_MS) {
      this.onTap(press.x, press.y, press.touch);
      return;
    }
    const recent = e.timeStamp - this.lastMoveT < 60;
    // Fast: the anchor's content moves more than 0.05 px per ms.
    const fast = Math.abs(this.velocity) * this.rig.scale > 0.05;
    if (this.pointers.size === 0 && recent && fast && !this.reducedMotion && !this.rig.isFree()) {
      this.onFling(this.velocity);
      this.onChange();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case '+':
      case '=':
        this.zoomTo(KEY_ZOOM);
        break;
      case '-':
      case '_':
        this.zoomTo(1 / KEY_ZOOM);
        break;
      default:
        return;
    }
    this.onUserInput();
    e.preventDefault();
  }
}

/** The angle (radians, counter-clockwise on screen) one finger turned from `prev` to `p` round the other one. */
function twistAngle(prev: Ptr, p: Ptr, other: Ptr): number {
  // y down on screen, so negate for counter-clockwise.
  const a0 = Math.atan2(-(prev.y - other.y), prev.x - other.x);
  const a1 = Math.atan2(-(p.y - other.y), p.x - other.x);
  let twist = a1 - a0;
  if (twist > Math.PI) twist -= 2 * Math.PI;
  if (twist < -Math.PI) twist += 2 * Math.PI;
  return twist;
}
