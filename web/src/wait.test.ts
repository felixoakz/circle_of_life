import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wait } from './wait';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('wait', () => {
  it('resolves true once the selection has settled', async () => {
    const ctl = new AbortController();
    let done: boolean | null = null;
    void wait(500, ctl.signal).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('resolves false at once when the selection changes first', async () => {
    const ctl = new AbortController();
    let done: boolean | null = null;
    void wait(500, ctl.signal).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(200);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false for a signal that has already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(wait(500, ctl.signal)).resolves.toBe(false);
  });

  it('lets only the last of a quick run of selections through', async () => {
    // Arrow keys through five siblings 100 ms apart: one /about, for the last.
    const passed: number[] = [];
    let ctl: AbortController | null = null;
    for (let i = 0; i < 5; i++) {
      ctl?.abort();
      const mine = new AbortController();
      ctl = mine;
      void wait(500, mine.signal).then((ok) => ok && passed.push(i));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(passed).toEqual([4]);
  });
});
