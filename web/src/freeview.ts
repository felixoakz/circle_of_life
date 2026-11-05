// Free view (DESIGN.md §4.1, §8): an opt-in mode that lets go of the locked
// composition, so any part of the wheel (the inner branches too) can be
// panned to and zoomed into. The rig does the maths (rig.ts `free`); this
// module only switches the mode, from the button beside the zoom strip, `F`
// and `Esc`.
//
// Entering keeps the picture exactly where it is (the free pose is the
// camera's) and stops the wheel's own motion: no ambient turn, no tour, no
// auto-orient, no anchor drift while free (main.ts holds them on `on()`).
// Leaving flies back to the locked view (flyto.ts, a cut under reduced
// motion) on the selection:
//   - the selection is the one free view began with: back to the locked
//     pose it left (the same rotation and zoom);
//   - a new one (clicked while free, or a link that opened in free view):
//     on the anchor at the zoom that suits it, as search flies there.
// Any other "take me there" (search, breadcrumb, key, the arrow keys,
// reset) flies through the same path and so leaves free view too.

import type { Flight } from './flyto';
import type { Pose, Rig } from './rig';

/** What free view drives: the scene's rig and flight, and what it stops on the way in (scene.ts). */
export interface FreeViewHost {
  readonly rig: Rig;
  readonly flight: Flight;
  readonly input: { cancel(): void };
  readonly spin: { interact(now: number): void };
  requestRender(): void;
}

/** What free view began from: the locked pose and the selection then. */
export interface FreeEntry {
  pose: Pose;
  selected: number | null;
}

/** The locked pose to return to: where free view began if the selection is the same, else `suit` of the selection. */
export function returnPose(entry: FreeEntry | null, selected: number | null, suit: () => Pose | null): Pose | null {
  if (entry && entry.selected === selected) return entry.pose;
  return suit();
}

export class FreeView {
  /** The selection's id (main.ts, from selection.ts). */
  selected: () => number | null = () => null;
  /** The locked pose that suits the selection (selection.ts `suitPose`), or null without one. */
  suit: () => Pose | null = () => null;

  private readonly scene: FreeViewHost;
  private entry: FreeEntry | null = null;

  constructor(scene: FreeViewHost) {
    this.scene = scene;
  }

  /** True in free view, and not already flying back out of it. */
  on(): boolean {
    return this.scene.rig.isFree() && !this.scene.flight.active();
  }

  toggle(): void {
    if (this.on()) this.leave();
    else this.enter();
  }

  /** Lets go of the composition where the view is now (a flight back is stopped where it is). */
  enter(): void {
    const scene = this.scene;
    const rig = scene.rig;
    const now = performance.now();
    scene.flight.cancel(now);
    scene.input.cancel();
    scene.spin.interact(now);
    if (!rig.isFree()) {
      this.entry = { pose: rig.pose(), selected: this.selected() };
      rig.enterFree();
    }
    scene.requestRender();
  }

  /** Flies back to the locked view on the selection (a cut under reduced motion). */
  leave(): void {
    const scene = this.scene;
    if (!scene.rig.isFree()) return;
    const to = returnPose(this.entry, this.selected(), this.suit);
    this.entry = null;
    scene.input.cancel();
    if (to) scene.flight.fly(to);
    else scene.rig.set(scene.rig.pose());
    scene.requestRender();
  }
}
