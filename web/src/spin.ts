// The wheel's own motion (DESIGN.md §6): a slow ambient turn while nobody
// is touching it, and fling inertia after a drag or a two-finger twist.
//
// One angular velocity `v` (radians of `theta` per ms, as Rig.rotateBy
// takes them) eases towards a target with friction:
//   v ← T + (v − T) · e^(−dt/τ),   τ = FRICTION_MS
// and the wheel turns by the exact integral of that over each frame. A
// fling sets `v` to the release velocity, so it spins on and decays into
// the target: 0 while the wheel is paused, the ambient rate once it is idle.
//
// The ambient rate is a constant speed at the anchor, AMBIENT_PX_PER_S CSS
// px per second, so it is equally calm at every zoom: about one turn every
// four minutes at minimum zoom on a desktop, a name row every two seconds
// or so at maximum zoom. It turns clockwise.
//
// Pauses. A user input (drag, wheel, pinch, key, click) stops the ambient
// turn at once (a fling keeps its own velocity) and it eases back in after
// RESUME_MS of quiet, over RAMP_MS. While `blocked` says so (a flight, a
// drag, the pointer over the card or a hovered node, search open, an
// input focused, the tab hidden, the intro) the target is 0 and it eases
// back in BLOCK_RESUME_MS after the block ends. Off under reduced motion
// and `?still`.

import { smoothstep } from './ease';
import type { Rig } from './rig';

/** Ambient speed at the anchor, CSS px per second. */
export const AMBIENT_PX_PER_S = 20;
/** Friction time constant: a fling decays (and the ambient turn eases) with this, ms. */
export const FRICTION_MS = 400;
/** Quiet time before the ambient turn comes back after a user input, and its ease-in, ms. */
export const RESUME_MS = 3000;
export const RAMP_MS = 2000;
/** The same after a block (flight, hover, search) ends, ms. */
export const BLOCK_RESUME_MS = 800;

/** The ambient angular velocity at `scale` device px per world unit (clockwise: negative). */
export function ambientRate(scale: number, dpr: number): number {
  return -((AMBIENT_PX_PER_S / 1000) * dpr) / Math.max(scale, 1e-9);
}

/** One friction step: the new velocity and the angle turned over `dt` ms, exactly. */
export function frictionStep(v: number, target: number, dt: number): { v: number; turned: number } {
  const k = Math.exp(-dt / FRICTION_MS);
  return { v: target + (v - target) * k, turned: target * dt + (v - target) * FRICTION_MS * (1 - k) };
}

export class Spin {
  /** False under reduced motion or `?still`: no ambient turn and no fling. */
  enabled = true;
  /** True while the wheel must not drift (main.ts joins flight, drag, hover, search, focus, hidden tab, intro). */
  blocked: () => boolean = () => false;
  /** Asks for frames again after a pause (the scene's requestRender). */
  wake: () => void = () => {};

  private readonly rig: Rig;
  private v = 0;
  private last = -1;
  /** When the ambient turn may start easing back in. */
  private resumeAt = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(rig: Rig) {
    this.rig = rig;
  }

  /** The current angular velocity (rad/ms), for tests. */
  velocity(): number {
    return this.v;
  }

  /** A user input: stop now, and come back after RESUME_MS of quiet. */
  interact(now: number): void {
    this.v = 0;
    this.pause(now + RESUME_MS);
  }

  /** A drag or twist was released at `v` rad/ms: spin on and decay. */
  fling(v: number, now: number): void {
    if (!this.enabled) return;
    this.v = v;
    this.last = now;
    this.pause(now + RESUME_MS);
    this.wake();
  }

  /** Advances the wheel to `now`; true while it wants more frames. */
  step(now: number): boolean {
    // Capped so a long gap (a hidden tab, a stalled frame) cannot jump the wheel.
    const dt = this.last < 0 ? 0 : Math.min(250, Math.max(0, now - this.last));
    this.last = now;
    if (!this.enabled) return false;
    let target = 0;
    if (this.blocked()) {
      this.pause(now + BLOCK_RESUME_MS);
    } else {
      const ramp = smoothstep(0, RAMP_MS, now - this.resumeAt);
      target = ambientRate(this.rig.scale, this.rig.camera.dpr) * ramp;
    }
    const s = frictionStep(this.v, target, dt);
    this.v = s.v;
    if (s.turned !== 0) this.rig.rotateBy(s.turned);
    // Keep frames coming while it turns; a stopped wheel waits for its timer.
    return Math.abs(this.v) > 1e-12 || target !== 0;
  }

  /** Holds the ambient turn until `at` (keeping the later of two holds), with a timer to wake the frame loop. */
  private pause(at: number): void {
    this.resumeAt = Math.max(this.resumeAt, at);
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this.wake(), Math.max(0, this.resumeAt - performance.now()) + 16);
  }
}
