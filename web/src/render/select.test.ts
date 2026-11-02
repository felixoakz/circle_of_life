import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunPalette } from '../palette';
import {
  type AdapterLike,
  type GpuLike,
  LOSS_MEMO_KEY,
  backendOrder,
  createRenderer,
  rememberWebGpuLoss,
  rendererOptions,
  requestGpuDevice,
  webglReloadUrl,
  webgpuFailedBefore,
} from './select';
import type { BackendKind, Renderer, RendererFactory, RendererOptions } from './types';

const q = (s: string): URLSearchParams => new URLSearchParams(s);
const GPU_OK = { hasGpu: true, webgpuFailedBefore: false };
const NO_GPU = { hasGpu: false, webgpuFailedBefore: false };
const LOST = { hasGpu: true, webgpuFailedBefore: true };

describe('backendOrder', () => {
  it('tries WebGPU first, then WebGL2, by default', () => {
    expect(backendOrder(q(''), GPU_OK)).toEqual(['webgpu', 'webgl2']);
  });

  it('skips WebGPU without navigator.gpu', () => {
    expect(backendOrder(q(''), NO_GPU)).toEqual(['webgl2']);
  });

  it('skips WebGPU after an earlier unrecoverable loss this session', () => {
    expect(backendOrder(q(''), LOST)).toEqual(['webgl2']);
  });

  it('?renderer=webgl forces WebGL2', () => {
    expect(backendOrder(q('renderer=webgl'), GPU_OK)).toEqual(['webgl2']);
    expect(backendOrder(q('renderer=webgl'), NO_GPU)).toEqual(['webgl2']);
  });

  it('?renderer=webgpu keeps WebGL2 as the fallback', () => {
    expect(backendOrder(q('renderer=webgpu'), GPU_OK)).toEqual(['webgpu', 'webgl2']);
    expect(backendOrder(q('renderer=webgpu'), NO_GPU)).toEqual(['webgl2']);
  });

  it('?renderer=webgpu overrides the loss memo (the user asked for it)', () => {
    expect(backendOrder(q('renderer=webgpu'), LOST)).toEqual(['webgpu', 'webgl2']);
  });

  it('an unknown ?renderer value means the default', () => {
    expect(backendOrder(q('renderer=vulkan'), GPU_OK)).toEqual(['webgpu', 'webgl2']);
  });

  it('?nowebgl tries nothing (the fallback page), whatever else is set', () => {
    for (const env of [GPU_OK, NO_GPU, LOST]) {
      expect(backendOrder(q('nowebgl'), env)).toEqual([]);
      expect(backendOrder(q('nowebgl&renderer=webgpu'), env)).toEqual([]);
      expect(backendOrder(q('renderer=webgl&nowebgl'), env)).toEqual([]);
    }
  });
});

describe('rendererOptions', () => {
  it('accepts a software adapter only when the URL forces WebGPU', () => {
    expect(rendererOptions(q(''))).toEqual({ allowFallbackAdapter: false });
    expect(rendererOptions(q('renderer=webgl'))).toEqual({ allowFallbackAdapter: false });
    expect(rendererOptions(q('renderer=webgpu'))).toEqual({ allowFallbackAdapter: true });
  });
});

// ---- createRenderer with typed fake factories ----

function fakeRenderer(kind: BackendKind): Renderer {
  return {
    kind,
    upload: (t) => ({ level: t.level, count: t.count, internalCount: t.internalCount }),
    release: () => {},
    setFans: () => {},
    draw: (tiles) => ({ tiles: tiles.length, instances: 0, drawCalls: 0 }),
    size: () => ({ width: 1, height: 1 }),
    finish: () => Promise.resolve(),
    readPixels: () => Promise.resolve({ width: 0, height: 0, data: new Uint8Array(0) }),
    gpuMs: () => null,
    onLost: () => {},
    onRestored: () => {},
    destroy: () => {},
  };
}

type Outcome = 'ok' | 'null' | 'throw';

function factories(webgpu: Outcome, webgl2: Outcome) {
  const calls: { kind: BackendKind; opts: RendererOptions }[] = [];
  const make =
    (kind: BackendKind, outcome: Outcome): RendererFactory =>
    async (_canvas, _palette, opts) => {
      calls.push({ kind, opts });
      if (outcome === 'throw') throw new Error(`${kind} exploded`);
      return outcome === 'ok' ? fakeRenderer(kind) : null;
    };
  const table: Record<BackendKind, RendererFactory> = {
    webgpu: make('webgpu', webgpu),
    webgl2: make('webgl2', webgl2),
  };
  return { table, calls };
}

// The factories never touch the canvas in these tests.
const canvas = {} as HTMLCanvasElement;
const palette = new RunPalette([], 100);
const BOTH: BackendKind[] = ['webgpu', 'webgl2'];

describe('createRenderer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the first backend that comes up and does not build the rest', async () => {
    const { table, calls } = factories('ok', 'ok');
    const r = await createRenderer(canvas, palette, BOTH, table);
    expect(r?.kind).toBe('webgpu');
    expect(calls.map((c) => c.kind)).toEqual(['webgpu']);
  });

  it('falls back to WebGL2 when WebGPU gives null', async () => {
    const { table, calls } = factories('null', 'ok');
    const r = await createRenderer(canvas, palette, BOTH, table);
    expect(r?.kind).toBe('webgl2');
    expect(calls.map((c) => c.kind)).toEqual(['webgpu', 'webgl2']);
  });

  it('falls back to WebGL2 when the WebGPU factory throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { table } = factories('throw', 'ok');
    const r = await createRenderer(canvas, palette, BOTH, table);
    expect(r?.kind).toBe('webgl2');
  });

  it('returns null (the fallback page) when every backend fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createRenderer(canvas, palette, BOTH, factories('null', 'null').table)).toBeNull();
    expect(await createRenderer(canvas, palette, BOTH, factories('throw', 'throw').table)).toBeNull();
  });

  it('builds nothing for an empty order (?nowebgl)', async () => {
    const { table, calls } = factories('ok', 'ok');
    expect(await createRenderer(canvas, palette, [], table)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('only tries what the order lists', async () => {
    const { table, calls } = factories('ok', 'ok');
    const r = await createRenderer(canvas, palette, ['webgl2'], table);
    expect(r?.kind).toBe('webgl2');
    expect(calls.map((c) => c.kind)).toEqual(['webgl2']);
  });

  it('passes the options to every factory, defaulting to no software adapter', async () => {
    const a = factories('null', 'ok');
    await createRenderer(canvas, palette, BOTH, a.table);
    expect(a.calls.map((c) => c.opts)).toEqual([
      { allowFallbackAdapter: false },
      { allowFallbackAdapter: false },
    ]);
    const b = factories('ok', 'ok');
    await createRenderer(canvas, palette, BOTH, b.table, { allowFallbackAdapter: true });
    expect(b.calls[0]?.opts).toEqual({ allowFallbackAdapter: true });
  });
});

// ---- WebGPU adapter and device policy ----

interface FakeDevice {
  label: string;
}

function fakeGpu(adapter: 'none' | 'hardware' | 'software', device: 'ok' | 'throw') {
  const log = { requestDevice: 0 };
  const make = (isFallbackAdapter: boolean): AdapterLike<FakeDevice> => ({
    info: { isFallbackAdapter },
    requestDevice: async () => {
      log.requestDevice++;
      if (device === 'throw') throw new Error('device request failed');
      return { label: 'dev' };
    },
  });
  const gpu: GpuLike<FakeDevice> = {
    requestAdapter: async () => (adapter === 'none' ? null : make(adapter === 'software')),
  };
  return { gpu, log };
}

const STRICT: RendererOptions = { allowFallbackAdapter: false };
const LOOSE: RendererOptions = { allowFallbackAdapter: true };

describe('requestGpuDevice', () => {
  afterEach(() => vi.restoreAllMocks());

  it('real navigator.gpu fits the fakeable shape', () => {
    // Compile-time check: GPU is assignable to GpuLike<GPUDevice>.
    const asLike = (g: GPU): GpuLike<GPUDevice> => g;
    expect(typeof asLike).toBe('function');
  });

  it('returns the device of a hardware adapter', async () => {
    expect(await requestGpuDevice(fakeGpu('hardware', 'ok').gpu, STRICT)).toEqual({ label: 'dev' });
  });

  it('gives null without navigator.gpu', async () => {
    expect(await requestGpuDevice(undefined, STRICT)).toBeNull();
  });

  it('gives null when requestAdapter returns null', async () => {
    expect(await requestGpuDevice(fakeGpu('none', 'ok').gpu, LOOSE)).toBeNull();
  });

  it('gives null when requestDevice throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await requestGpuDevice(fakeGpu('hardware', 'throw').gpu, STRICT)).toBeNull();
  });

  it('rejects a software adapter by default, without asking it for a device', async () => {
    const { gpu, log } = fakeGpu('software', 'ok');
    expect(await requestGpuDevice(gpu, STRICT)).toBeNull();
    expect(log.requestDevice).toBe(0);
  });

  it('asks for timestamp-query only when the adapter offers it', async () => {
    const asked: (GPUFeatureName[] | undefined)[] = [];
    const adapter = (offered: boolean): AdapterLike<FakeDevice> => ({
      info: { isFallbackAdapter: false },
      features: { has: (name) => offered && name === 'timestamp-query' },
      requestDevice: async (desc) => {
        asked.push(desc?.requiredFeatures);
        return { label: 'dev' };
      },
    });
    await requestGpuDevice({ requestAdapter: async () => adapter(true) }, STRICT);
    await requestGpuDevice({ requestAdapter: async () => adapter(false) }, STRICT);
    expect(asked).toEqual([['timestamp-query'], []]);
  });

  it('accepts a software adapter when forced, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await requestGpuDevice(fakeGpu('software', 'ok').gpu, LOOSE)).toEqual({ label: 'dev' });
    expect(warn).toHaveBeenCalled();
  });

  it('does not warn for a hardware adapter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await requestGpuDevice(fakeGpu('hardware', 'ok').gpu, LOOSE);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loss memo', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  }

  it('round-trips through storage', () => {
    const s = memoryStorage();
    expect(webgpuFailedBefore(s)).toBe(false);
    rememberWebGpuLoss(s);
    expect(webgpuFailedBefore(s)).toBe(true);
    expect(s.getItem(LOSS_MEMO_KEY)).not.toBeNull();
  });

  it('treats missing or throwing storage as no memo', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(webgpuFailedBefore(null)).toBe(false);
    expect(webgpuFailedBefore(broken)).toBe(false);
    expect(() => rememberWebGpuLoss(broken)).not.toThrow();
    expect(() => rememberWebGpuLoss(null)).not.toThrow();
  });
});

describe('webglReloadUrl', () => {
  it('forces WebGL2 and keeps the selection and the live camera', () => {
    expect(webglReloadUrl('?renderer=webgpu&debug&n=ott770315&v=1,0.5,3,0', '2,0.9,10.5,-30')).toBe(
      '?renderer=webgl&n=ott770315&v=2,0.9,10.5,-30',
    );
  });

  it('falls back to the URL camera, and drops everything else', () => {
    expect(webglReloadUrl('?v=1,0.5,3,0&shot&passes=arcs', null)).toBe('?renderer=webgl&v=1,0.5,3,0');
    expect(webglReloadUrl('', null)).toBe('?renderer=webgl');
  });
});
