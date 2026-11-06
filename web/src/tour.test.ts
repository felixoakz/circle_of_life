import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESUME_DWELLS, TOUR, Tour, shuffled } from './tour';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tour', () => {
  it('lists distinct OpenTree ids across the kingdoms', () => {
    const ids = TOUR.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ott\d+$/);
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  it('visits every species once before repeating', () => {
    const seen: string[] = [];
    const tour = new Tour(0, 1000);
    tour.go = (id) => seen.push(id);
    for (let t = 0; t <= 1000 * TOUR.length; t += 100) tour.step(t);
    expect(seen.length).toBe(TOUR.length);
    expect(new Set(seen).size).toBe(TOUR.length);
  });

  it('hops after the dwell, holds while held, and stops on input for three dwells', () => {
    const seen: string[] = [];
    const tour = new Tour(0, 1000);
    tour.go = (id) => seen.push(id);
    tour.step(500);
    expect(seen.length).toBe(0);
    tour.step(1000);
    expect(seen.length).toBe(1);
    let held = true;
    tour.held = () => held;
    for (let t = 1000; t <= 5000; t += 100) tour.step(t);
    expect(seen.length).toBe(1);
    held = false;
    tour.step(5100);
    tour.step(6000);
    expect(seen.length).toBe(2);
    tour.interact(6000);
    expect(tour.isStopped()).toBe(true);
    for (let t = 6000; t < 6000 + 1000 * RESUME_DWELLS; t += 100) tour.step(t);
    expect(seen.length).toBe(2);
    tour.step(6000 + 1000 * RESUME_DWELLS);
    expect(seen.length).toBe(3);
  });

  it('shuffles without losing or duplicating', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const out = shuffled(ids, () => 0.3);
    expect([...out].sort()).toEqual(ids);
  });
});

describe('tour state', () => {
  it('waits firstMs before the first hop, then says it is touring until stopped', () => {
    const tour = new Tour(0, 1000, Math.random, 3000);
    tour.go = () => {};
    tour.step(2000);
    expect(tour.touring()).toBe(false);
    tour.step(3000);
    expect(tour.touring()).toBe(true);
    tour.interact(3100);
    expect(tour.touring()).toBe(false);
  });
});

describe('tour list', () => {
  it('gives every stop a kingdom', () => {
    for (const t of TOUR) expect(t.group).toBeGreaterThanOrEqual(0);
  });
});
