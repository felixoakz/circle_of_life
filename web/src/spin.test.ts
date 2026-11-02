import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera } from './camera';
import { layoutFor } from './layout';
import { Rig } from './rig';
import { AMBIENT_PX_PER_S, FRICTION_MS, RAMP_MS, RESUME_MS, Spin, ambientRate, frictionStep } from './spin';

function rig(): Rig {
  const cam = new Camera(2_385_875);
  cam.setViewport(2000, 1030, 1);
  const r = new Rig(cam);
  r.setLayout(layoutFor(2000, 1030));
  r.set({ theta: 1, scale: r.minScale() });
  return r;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('spin', () => {
  it('turns at a constant speed at the anchor, clockwise, about once in four minutes at minimum zoom', () => {
    const r = rig();
    const v = ambientRate(r.scale, 1);
    expect(v).toBeLessThan(0);
    expect(Math.abs(v) * r.scale * 1000).toBeCloseTo(AMBIENT_PX_PER_S, 9);
    const turnMinutes = (2 * Math.PI) / Math.abs(v) / 60_000;
    expect(turnMinutes).toBeGreaterThan(3);
    expect(turnMinutes).toBeLessThan(5);
  });

  it('integrates friction exactly, whatever the frame rate', () => {
    let a = { v: 0.01, turned: 0 };
    let total = 0;
    for (let i = 0; i < 60; i++) {
      a = frictionStep(a.v, 0, 16);
      total += a.turned;
    }
    const once = frictionStep(0.01, 0, 960);
    expect(a.v).toBeCloseTo(once.v, 12);
    expect(total).toBeCloseTo(once.turned, 12);
    expect(once.turned).toBeLessThan(0.01 * FRICTION_MS);
  });

  it('lets a fling decay, then eases the ambient turn back in after the quiet time', () => {
    const r = rig();
    const s = new Spin(r);
    s.step(0);
    s.fling(1e-4, 0);
    let t = 0;
    for (; t < 2000; t += 16) s.step(t);
    expect(Math.abs(s.velocity())).toBeLessThan(1e-4 * 0.01);
    for (; t < RESUME_MS + RAMP_MS + 2000; t += 16) s.step(t);
    expect(s.velocity() / ambientRate(r.scale, 1)).toBeCloseTo(1, 2);
  });

  it('holds still while blocked, and does nothing when disabled', () => {
    const r = rig();
    const s = new Spin(r);
    s.blocked = () => true;
    for (let t = 0; t < 20_000; t += 16) s.step(t);
    expect(s.velocity()).toBe(0);
    const off = new Spin(r);
    off.enabled = false;
    off.fling(1, 0);
    expect(off.step(16)).toBe(false);
    expect(r.theta).toBe(1);
  });
});
