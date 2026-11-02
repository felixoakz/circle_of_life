import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { layoutFor } from './layout';
import { AutoOrient } from './orient';
import { Rig } from './rig';
import { ORIENT_MS } from './style';

function deepRig(): Rig {
  const cam = new Camera(2_385_875);
  cam.setViewport(1440, 900, 1);
  const rig = new Rig(cam);
  rig.setLayout(layoutFor(1440, 900));
  rig.set({ theta: 2, scale: rig.maxScale() });
  return rig;
}

describe('AutoOrient', () => {
  it('eases the turn off and back on, keeping the anchor point put', () => {
    const rig = deepRig();
    const orient = new AutoOrient(rig);
    const a = rig.anchor();
    expect(rig.camera.rot).toBeCloseTo(-2, 12); // focus 0°: rot = −theta
    orient.toggle(0);
    expect(orient.step(ORIENT_MS / 2)).toBe(true);
    expect(rig.turn).toBeGreaterThan(0);
    expect(rig.turn).toBeLessThan(1);
    expect(orient.step(ORIENT_MS)).toBe(false);
    expect(rig.turn).toBe(0);
    // Off: the layout's focus angle at every zoom.
    expect(rig.camera.rot).toBeCloseTo(layoutFor(1440, 900).focus - 2, 12);
    const p = rig.camera.polarToScreen(2, 1);
    expect(p.x).toBeCloseTo(a.x, 4);
    expect(p.y).toBeCloseTo(a.y, 4);
    orient.toggle(1000);
    orient.step(1000 + ORIENT_MS);
    expect(rig.turn).toBe(1);
  });

  it('cuts with reduced motion', () => {
    const rig = deepRig();
    const orient = new AutoOrient(rig);
    orient.reducedMotion = true;
    orient.toggle(0);
    expect(rig.turn).toBe(0);
    expect(orient.step(1)).toBe(false);
  });
});
