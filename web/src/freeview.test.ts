import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { Flight } from './flyto';
import { FreeView, returnPose } from './freeview';
import { layoutFor } from './layout';
import { Rig } from './rig';

const N = 2_385_875;

function host(): { rig: Rig; flight: Flight; input: { cancel(): void }; spin: { interact(now: number): void }; requestRender(): void; stopped: number } {
  const cam = new Camera(N);
  cam.setViewport(1440, 900, 1);
  const rig = new Rig(cam);
  rig.setLayout(layoutFor(1440, 900));
  rig.set({ theta: 1.3, scale: rig.minScale() * 4 });
  const h = {
    rig,
    flight: new Flight(rig),
    input: { cancel: () => {} },
    spin: { interact: () => void h.stopped++ },
    requestRender: () => {},
    stopped: 0,
  };
  return h;
}

describe('returnPose', () => {
  const suit = () => ({ theta: 2, scale: 99 });
  it('goes back where free view began while the selection is the same', () => {
    const entry = { pose: { theta: 1, scale: 10 }, selected: 7 };
    expect(returnPose(entry, 7, suit)).toEqual({ theta: 1, scale: 10 });
  });
  it('suits a new selection, or a free view that began from a link', () => {
    expect(returnPose({ pose: { theta: 1, scale: 10 }, selected: 7 }, 8, suit)).toEqual({ theta: 2, scale: 99 });
    expect(returnPose(null, 7, suit)).toEqual({ theta: 2, scale: 99 });
  });
});

describe('FreeView', () => {
  it('enters without moving the picture and stops the wheel', () => {
    const h = host();
    const fv = new FreeView(h);
    const before = h.rig.camera.worldToScreen(0.4, 0.7);
    fv.toggle();
    expect(fv.on()).toBe(true);
    expect(h.stopped).toBe(1);
    const after = h.rig.camera.worldToScreen(0.4, 0.7);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('flies back to the locked pose it left, landing locked', () => {
    const h = host();
    const fv = new FreeView(h);
    fv.selected = () => 7;
    const start = h.rig.pose();
    fv.enter();
    h.rig.panBy(400, -250);
    h.rig.zoomAt(30, { x: 200, y: 300 });
    fv.toggle();
    // Flying back: no longer "on", though the rig is free until it lands.
    expect(fv.on()).toBe(false);
    expect(h.rig.isFree()).toBe(true);
    h.flight.step(performance.now() + 10_000);
    expect(h.rig.isFree()).toBe(false);
    expect(h.rig.theta).toBeCloseTo(start.theta, 12);
    expect(h.rig.scale).toBeCloseTo(start.scale, 6);
  });

  it('suits a selection made while free', () => {
    const h = host();
    const fv = new FreeView(h);
    let sel = 7;
    fv.selected = () => sel;
    fv.suit = () => ({ theta: 0.5, scale: h.rig.minScale() * 100 });
    fv.enter();
    sel = 8;
    fv.leave();
    h.flight.step(performance.now() + 10_000);
    expect(h.rig.theta).toBeCloseTo(0.5, 12);
    expect(h.rig.scale).toBeCloseTo(h.rig.minScale() * 100, 6);
  });

  it('cuts back under reduced motion', () => {
    const h = host();
    h.flight.reducedMotion = true;
    const fv = new FreeView(h);
    fv.enter();
    h.rig.panBy(100, 100);
    fv.leave();
    expect(h.rig.isFree()).toBe(false);
  });

  it('entering again during the flight back stays free where it is', () => {
    const h = host();
    const fv = new FreeView(h);
    fv.enter();
    h.rig.panBy(500, 0);
    fv.leave();
    h.flight.step(performance.now() + 100);
    fv.toggle();
    expect(h.flight.active()).toBe(false);
    expect(fv.on()).toBe(true);
  });
});
