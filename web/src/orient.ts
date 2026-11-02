// Auto-orient (PLAN §7.5): at deep zoom the rim turns vertical at the anchor
// so tip names read left to right (docs/reference/1.png).
//
// The turn itself is a function of zoom (rig.ts `focusAngle`): the focus
// angle eases from the layout's 30° (60° on a phone) to 0° as tips spread
// from 0.25 to 4 px apart. Because the rig keeps the world point at the
// anchor fixed, the view turns about the anchor while zooming, and the
// selection never moves. There is no tween to chase and nothing for a
// flight to coordinate with: the rotation follows the zoom.
//
// This class only switches it on and off (R, the wordmark menu): the rig's
// `turn` share eases between 1 and 0 over ORIENT_MS, a cut with reduced
// motion.

import { easeInOut } from './ease';
import type { Rig } from './rig';
import { ORIENT_MS } from './style';

export class AutoOrient {
  enabled = true;
  reducedMotion = false;

  private readonly rig: Rig;
  private tween: { from: number; to: number; t0: number } | null = null;

  constructor(rig: Rig) {
    this.rig = rig;
  }

  /** Switches auto-orient on or off. */
  toggle(now: number): void {
    this.set(!this.enabled, now);
  }

  set(on: boolean, now: number): void {
    this.enabled = on;
    const to = on ? 1 : 0;
    if (this.reducedMotion) {
      this.tween = null;
      this.rig.turn = to;
      this.rig.apply();
      return;
    }
    this.tween = { from: this.rig.turn, to, t0: now };
  }

  /** Eases the rig's turn for time `now`; true while animating. */
  step(now: number): boolean {
    const tw = this.tween;
    if (!tw) return false;
    const t = Math.min(1, (now - tw.t0) / ORIENT_MS);
    this.rig.turn = tw.from + (tw.to - tw.from) * easeInOut(t);
    this.rig.apply();
    if (t >= 1) this.tween = null;
    return this.tween !== null;
  }
}
