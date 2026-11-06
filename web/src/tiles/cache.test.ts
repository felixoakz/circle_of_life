import { describe, expect, it } from 'vitest';
import { tileKey } from '../lod';
import { TileCache } from './cache';
import { encodeTile } from './testTile';

interface Request {
  level: number;
  sector: number;
  signal: AbortSignal;
  resolve: (b: ArrayBuffer | null) => void;
}

function setup(cap = 400) {
  const requests: Request[] = [];
  const released: number[] = [];
  const cache = new TileCache<number>(
    {
      fetch: (level, sector, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          requests.push({ level, sector, signal, resolve });
        }),
      upload: (tile) => tileKey(tile.level, tile.sector),
      release: (gpu) => released.push(gpu),
    },
    cap,
  );
  const answer = async (r: Request): Promise<void> => {
    r.resolve(encodeTile(r.level, r.sector, [{ id: r.sector, parent: 0, angle: 0, tip: true }]));
    await new Promise((res) => setTimeout(res, 0));
  };
  return { cache, requests, released, answer };
}

describe('tile cache', () => {
  it('fetches at most 6 at once, in the given order', () => {
    const { cache, requests } = setup();
    cache.update([0, 1, 2, 3, 4, 5, 6, 7].map((s) => tileKey(3, s)));
    expect(requests.map((r) => r.sector)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('aborts requests that are no longer wanted', () => {
    const { cache, requests } = setup();
    cache.update([tileKey(5, 1), tileKey(5, 2)]);
    cache.update([tileKey(5, 2)]);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]?.signal.aborted).toBe(false);
    expect(cache.stats().aborted).toBe(1);
  });

  it('tracks completeness by level and treats 204 as loaded', async () => {
    const { cache, requests, answer } = setup();
    cache.update([tileKey(0, 0), tileKey(1, 0), tileKey(1, 1)]);
    expect(cache.completeLevel()).toBe(-1);
    await answer(requests[0] as Request);
    expect(cache.completeLevel()).toBe(0);
    await answer(requests[1] as Request);
    requests[2]?.resolve(null); // empty tile
    await new Promise((res) => setTimeout(res, 0));
    expect(cache.completeLevel()).toBe(1);
    expect(cache.pending()).toBe(0);
    expect(cache.drawable().length).toBe(2);
  });

  it('evicts least recently wanted tiles above level 3, never past the cap', async () => {
    const { cache, requests, released, answer } = setup(4);
    const pinned = [tileKey(2, 0), tileKey(3, 0)];
    for (let s = 0; s < 6; s++) {
      cache.update([...pinned, tileKey(8, s)]);
      for (const r of requests.filter((q) => !q.signal.aborted)) await answer(r);
      requests.length = 0;
    }
    expect(cache.stats().resident).toBe(4);
    // Pinned levels survive; the oldest level-8 tiles went first.
    expect(released).toEqual([tileKey(8, 0), tileKey(8, 1), tileKey(8, 2), tileKey(8, 3)]);
  });
});
