// Typed fetch wrappers for the read API (PLAN §5.1).

import type { About, Meta, NodeInfo, SearchHit } from './types';

export async function fetchMeta(signal?: AbortSignal): Promise<Meta> {
  const res = await fetch('/api/meta', { signal });
  if (!res.ok) throw new Error(`/api/meta: HTTP ${res.status}`);
  return (await res.json()) as Meta;
}

/** Thrown when the server no longer has this data version (it was re-ingested). */
export class StaleVersionError extends Error {}

/**
 * Raw tile bytes, or null for an empty tile (204). The server sends tiles
 * with `Content-Encoding: gzip`, so the browser has already inflated them.
 */
export async function fetchTile(
  version: string,
  level: number,
  sector: number,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  const res = await fetch(`/api/v/${encodeURIComponent(version)}/tiles/${level}/${sector}`, {
    signal,
  });
  if (res.status === 204) return null;
  if (res.status === 404) throw new StaleVersionError(`data version ${version} is gone`);
  if (!res.ok) throw new Error(`tile ${level}/${sector}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** A node with its lineage; `ref` is a pre-order id, `ott…` or `mrcaott…`. */
export async function fetchNode(ref: number | string, signal?: AbortSignal): Promise<NodeInfo> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(String(ref))}`, { signal });
  if (!res.ok) throw new Error(`/api/nodes/${ref}: HTTP ${res.status}`);
  return (await res.json()) as NodeInfo;
}

/** Search results for `q`, best first (PLAN §5.2). */
export async function fetchSearch(q: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal });
  if (!res.ok) throw new Error(`/api/search: HTTP ${res.status}`);
  return (await res.json()) as SearchHit[];
}

/**
 * The enrichment document for a node (PLAN §6). Slow on a cache miss (a few
 * seconds). `retry` asks the server to refetch a partial document.
 */
export async function fetchAbout(ref: number | string, retry: boolean, signal?: AbortSignal): Promise<About> {
  const q = retry ? '?retry=1' : '';
  const res = await fetch(`/api/nodes/${encodeURIComponent(String(ref))}/about${q}`, { signal });
  if (!res.ok) throw new Error(`/api/nodes/${ref}/about: HTTP ${res.status}`);
  return (await res.json()) as About;
}
