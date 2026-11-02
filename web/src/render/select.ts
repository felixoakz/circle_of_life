// Backend selection (docs/plan-webgpu.md §1): which renderers to try, in
// what order, and the WebGPU adapter/device policy. A canvas that gave a
// `webgpu` context can never give `webgl2`, so all of this finishes before
// any `getContext`.

import type { RunPalette } from '../palette';
import type { BackendKind, Renderer, RendererFactory, RendererOptions } from './types';

export interface SelectEnv {
  /** `navigator.gpu` exists. */
  hasGpu: boolean;
  /** The session memo says WebGPU was lost earlier and could not recover. */
  webgpuFailedBefore: boolean;
}

/** sessionStorage key of the "WebGPU was lost" memo. */
export const LOSS_MEMO_KEY = 'species.webgpuLost';

/**
 * Every backend's factory. Each backend (its code and its shaders) is a
 * separate chunk loaded with a dynamic `import()`, so a visit downloads only
 * the one it uses. WebGPU asks for its adapter and device first, so
 * browsers without a usable adapter never download the WebGPU chunk.
 */
export const FACTORIES: Record<BackendKind, RendererFactory> = {
  webgpu: async (canvas, palette, opts) => {
    const device = await requestGpuDevice<GPUDevice>(navigator.gpu, opts);
    if (!device) return null;
    try {
      const { createWebGpuRenderer } = await import('../gpu/renderer');
      return await createWebGpuRenderer(device, canvas, palette, opts);
    } catch (err) {
      device.destroy();
      throw err;
    }
  },
  webgl2: async (canvas, palette, opts) => (await import('../gl/renderer')).createWebGl2Renderer(canvas, palette, opts),
};

/** The backends to try, best first; empty for `?nowebgl` (the fallback page). */
export function backendOrder(q: URLSearchParams, env: SelectEnv): BackendKind[] {
  if (q.has('nowebgl')) return [];
  const asked = q.get('renderer');
  if (asked === 'webgl') return ['webgl2'];
  // Asking for WebGPU by name overrides the loss memo, not a missing API.
  const tryGpu = env.hasGpu && (asked === 'webgpu' || !env.webgpuFailedBefore);
  return tryGpu ? ['webgpu', 'webgl2'] : ['webgl2'];
}

/** Options for the factories: only `?renderer=webgpu` accepts a software adapter. */
export function rendererOptions(q: URLSearchParams): RendererOptions {
  return { allowFallbackAdapter: q.get('renderer') === 'webgpu' };
}

/** Tries each backend in order; the first non-null renderer wins, a throwing factory counts as null. */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  palette: RunPalette,
  order: readonly BackendKind[],
  factories: Record<BackendKind, RendererFactory>,
  opts: RendererOptions = { allowFallbackAdapter: false },
): Promise<Renderer | null> {
  for (const kind of order) {
    try {
      const r = await factories[kind](canvas, palette, opts);
      if (r) return r;
    } catch (err) {
      console.warn(`${kind} renderer failed`, err);
    }
  }
  return null;
}

/** The parts of `GPUAdapter` the device policy needs (fakeable in tests). */
export interface AdapterLike<D> {
  readonly info: { readonly isFallbackAdapter: boolean };
  /** Optional features on offer (gpu/timing.ts wants `timestamp-query`). */
  readonly features?: { has(name: string): boolean };
  requestDevice(desc?: { requiredFeatures?: GPUFeatureName[] }): Promise<D>;
}

/** The parts of `navigator.gpu` the device policy needs. */
export interface GpuLike<D> {
  requestAdapter(): Promise<AdapterLike<D> | null>;
}

/**
 * Adapter and device, or null: no `navigator.gpu`, no adapter, a software
 * adapter that was not allowed, or `requestDevice` throwing. An allowed
 * software adapter logs a `console.warn`. `timestamp-query` is requested
 * whenever the adapter offers it.
 */
export async function requestGpuDevice<D>(gpu: GpuLike<D> | undefined, opts: RendererOptions): Promise<D | null> {
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  if (adapter.info.isFallbackAdapter) {
    if (!opts.allowFallbackAdapter) return null;
    console.warn('WebGPU: using a software adapter (forced by ?renderer=webgpu)');
  }
  // Frame timing (gpu/timing.ts) needs the feature on the device; ask only when it is offered, or requestDevice fails.
  const requiredFeatures: GPUFeatureName[] = adapter.features?.has('timestamp-query') ? ['timestamp-query'] : [];
  try {
    return await adapter.requestDevice({ requiredFeatures });
  } catch (err) {
    console.warn('WebGPU: requestDevice failed', err);
    return null;
  }
}

/** Reads the loss memo; false when storage is unavailable or throws. */
export function webgpuFailedBefore(storage: Pick<Storage, 'getItem'> | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(LOSS_MEMO_KEY) !== null;
  } catch {
    return false;
  }
}

/** Sets the loss memo; storage errors are ignored. */
export function rememberWebGpuLoss(storage: Pick<Storage, 'setItem'> | null): void {
  if (!storage) return;
  try {
    storage.setItem(LOSS_MEMO_KEY, '1');
  } catch {
    // Private mode or a full quota: WebGPU is simply tried again next load.
  }
}

/**
 * The URL to reload into after an unrecoverable WebGPU loss: WebGL2, the
 * same selection (`n`) and the camera as it is now (`view`, `?v=` format).
 * Reloading avoids swapping the `#tree` canvas, which a `webgpu` context has
 * claimed for good.
 */
export function webglReloadUrl(search: string, view: string | null): string {
  const old = new URLSearchParams(search);
  const q = new URLSearchParams({ renderer: 'webgl' });
  const n = old.get('n');
  if (n !== null) q.set('n', n);
  const v = view ?? old.get('v');
  if (v !== null) q.set('v', v);
  // Commas are safe in a query; keep `v` readable.
  return `?${q.toString().replaceAll('%2C', ',')}`;
}
