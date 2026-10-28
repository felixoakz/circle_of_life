// A small shared cache of `/api/nodes/{ref}` answers (PLAN §5.1), used by
// the breadcrumb, hover, the panel and keyboard navigation, so moving
// between nodes that were already seen costs no request. Answers are keyed
// by pre-order id and by OpenTree node id (`ott…`, `mrcaott…`); a request in
// flight for the same key is shared.

import { fetchNode } from './api';
import type { NodeInfo } from './types';

const CAPACITY = 400;

export class NodeStore {
  private readonly byKey = new Map<string, NodeInfo>();
  private readonly pending = new Map<string, Promise<NodeInfo>>();

  /** The node if it is already cached (by id or OpenTree id). */
  peek(ref: number | string): NodeInfo | undefined {
    return this.byKey.get(String(ref));
  }

  /**
   * The node, from the cache or the API. `signal` aborts only this caller's
   * wait; a shared request keeps running for the others.
   */
  get(ref: number | string, signal?: AbortSignal): Promise<NodeInfo> {
    const key = String(ref);
    const hit = this.byKey.get(key);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(key);
    if (!p) {
      p = fetchNode(ref).then(
        (n) => {
          this.pending.delete(key);
          this.put(n);
          return n;
        },
        (err: unknown) => {
          this.pending.delete(key);
          throw err;
        },
      );
      this.pending.set(key, p);
    }
    return signal ? abortable(p, signal) : p;
  }

  private put(n: NodeInfo): void {
    if (this.byKey.size >= CAPACITY * 2) this.byKey.clear();
    this.byKey.set(String(n.id), n);
    this.byKey.set(n.nodeId, n);
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
