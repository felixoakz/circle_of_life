// Tile manager (PLAN §7.6): fetches wanted tiles in priority order (at most
// 6 at once), aborts requests that are no longer wanted, and keeps an LRU of
// decoded tiles with their GPU objects. Levels ≤ 3 are never evicted, so the
// coarse tree is always there to fall back on.
//
// It is generic over the GPU resource `G` so tests can run without a GPU.

import { StaleVersionError } from '../api';
import { keyLevel, keySector } from '../lod';
import { type Tile, decodeTile } from './decode';

export interface TileSource<G> {
  fetch(level: number, sector: number, signal: AbortSignal): Promise<ArrayBuffer | null>;
  upload(tile: Tile): G;
  release(gpu: G): void;
}

export interface Resident<G> {
  key: number;
  /** null for an empty tile (HTTP 204): nothing to draw, but nothing to refetch either. */
  tile: Tile | null;
  gpu: G | null;
  lastUsed: number;
}

const MAX_IN_FLIGHT = 6;
const MAX_RETRIES = 3;
const PINNED_LEVEL = 3;

export class TileCache<G> {
  /** Called whenever something visible changed (a tile arrived). */
  onChange: () => void = () => {};
  /** Called once when the server reports that our data version is gone. */
  onStale: () => void = () => {};
  /** Number of requests aborted because their tile was no longer wanted. */
  aborted = 0;

  private readonly source: TileSource<G>;
  private readonly cap: number;
  private readonly resident = new Map<number, Resident<G>>();
  private readonly inFlight = new Map<number, AbortController>();
  private readonly failures = new Map<number, { count: number; retryAt: number }>();
  private wanted: number[] = [];
  private wantedSet = new Set<number>();
  private tick = 0;
  private stale = false;

  constructor(source: TileSource<G>, cap = 400) {
    this.source = source;
    this.cap = cap;
  }

  /** Sets the wanted keys (already in priority order) and starts fetching. */
  update(keys: number[]): void {
    this.tick++;
    this.wanted = keys;
    this.wantedSet = new Set(keys);
    for (const k of keys) {
      const entry = this.resident.get(k);
      if (entry) entry.lastUsed = this.tick;
    }
    for (const [k, ctl] of this.inFlight) {
      if (!this.wantedSet.has(k)) {
        ctl.abort();
        this.inFlight.delete(k);
        this.aborted++;
      }
    }
    this.pump();
  }

  /** Resident, non-empty tiles among the wanted keys, lowest level first. */
  drawable(): Resident<G>[] {
    const out: Resident<G>[] = [];
    for (const k of this.wanted) {
      const entry = this.resident.get(k);
      if (entry && entry.gpu !== null) out.push(entry);
    }
    return out;
  }

  /**
   * The highest level whose wanted tiles (and all lower levels') are loaded,
   * or −1 if even level 0 is missing. Frontier extensions stay on until the
   * children's level is complete, so loading never opens gaps.
   */
  completeLevel(): number {
    // Wanted keys come sorted by level, every level from 0 up present.
    let level = 0;
    for (const k of this.wanted) {
      const L = keyLevel(k);
      if (L > level) level = L; // every key of the levels below was loaded
      if (!this.resident.has(k) && !this.gaveUp(k)) return level - 1;
    }
    return this.wanted.length > 0 ? level : -1;
  }

  /** Wanted tiles that are neither loaded nor abandoned after retries. */
  pending(): number {
    let n = 0;
    for (const k of this.wanted) if (!this.resident.has(k) && !this.gaveUp(k)) n++;
    return n;
  }

  stats(): { resident: number; inFlight: number; pending: number; aborted: number } {
    return {
      resident: this.resident.size,
      inFlight: this.inFlight.size,
      pending: this.pending(),
      aborted: this.aborted,
    };
  }

  /** Releases every GPU object and cancels every request. */
  clear(): void {
    for (const ctl of this.inFlight.values()) ctl.abort();
    this.inFlight.clear();
    for (const entry of this.resident.values()) if (entry.gpu !== null) this.source.release(entry.gpu);
    this.resident.clear();
    this.failures.clear();
  }

  /**
   * Re-uploads every resident tile from its CPU copy and releases the old
   * GPU objects (after a device loss the old ones are dead anyway).
   */
  rebuild(): void {
    for (const entry of this.resident.values()) {
      if (entry.tile === null || entry.gpu === null) continue;
      const old = entry.gpu;
      entry.gpu = this.source.upload(entry.tile);
      this.source.release(old);
    }
  }

  private gaveUp(k: number): boolean {
    return (this.failures.get(k)?.count ?? 0) >= MAX_RETRIES;
  }

  private pump(): void {
    const now = performance.now();
    for (const k of this.wanted) {
      if (this.stale || this.inFlight.size >= MAX_IN_FLIGHT) break;
      if (this.resident.has(k) || this.inFlight.has(k)) continue;
      const f = this.failures.get(k);
      if (f && (f.count >= MAX_RETRIES || now < f.retryAt)) continue;
      void this.load(k);
    }
  }

  private async load(k: number): Promise<void> {
    const ctl = new AbortController();
    this.inFlight.set(k, ctl);
    try {
      const buf = await this.source.fetch(keyLevel(k), keySector(k), ctl.signal);
      if (ctl.signal.aborted) return;
      const tile = buf ? decodeTile(buf) : null;
      const gpu = tile ? this.source.upload(tile) : null;
      this.resident.set(k, { key: k, tile, gpu, lastUsed: this.tick });
      this.failures.delete(k);
      this.evict();
    } catch (err) {
      if (ctl.signal.aborted) return;
      if (err instanceof StaleVersionError) {
        if (!this.stale) {
          this.stale = true;
          this.onStale();
        }
        return;
      }
      const count = (this.failures.get(k)?.count ?? 0) + 1;
      const delay = 500 * 2 ** count;
      this.failures.set(k, { count, retryAt: performance.now() + delay });
      console.warn(`tile ${keyLevel(k)}/${keySector(k)} failed (${count}/${MAX_RETRIES})`, err);
      if (count < MAX_RETRIES) setTimeout(() => this.pump(), delay);
    } finally {
      if (this.inFlight.get(k) === ctl) this.inFlight.delete(k);
      if (!ctl.signal.aborted) {
        this.pump();
        this.onChange();
      }
    }
  }

  /** Drops least-recently-wanted tiles above the pinned levels until within the cap. */
  private evict(): void {
    if (this.resident.size <= this.cap) return;
    const victims = [...this.resident.values()]
      .filter((e) => !this.wantedSet.has(e.key) && keyLevel(e.key) > PINNED_LEVEL)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of victims) {
      if (this.resident.size <= this.cap) break;
      if (e.gpu !== null) this.source.release(e.gpu);
      this.resident.delete(e.key);
    }
  }
}
