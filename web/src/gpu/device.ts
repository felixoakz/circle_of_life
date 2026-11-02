// Getting a WebGPU device, and watching it for errors and loss.
//
// WebGPU concepts used here:
// - `navigator.gpu` is the entry point. `requestAdapter()` picks a physical
//   GPU (or a software one, flagged `info.isFallbackAdapter`) and says what
//   it can do. `adapter.requestDevice()` opens a *device*: your own logical
//   connection to that GPU, which creates every buffer, texture and
//   pipeline, and owns the *queue* that work is submitted to.
// - Errors are not thrown. A bad call (wrong buffer usage, mismatched bind
//   group…) produces a validation error that arrives later on
//   `device.onuncapturederror`, and the object it made becomes "invalid".
//   We count them in `window.__gpuErrors`; harnesses assert it stays 0.
// - A device can be *lost* (driver reset, GPU process crash, `destroy()`).
//   `device.lost` is a promise that resolves once, with a reason. Every
//   buffer, texture and pipeline it made is dead with it; recovering means a
//   new adapter and device and re-creating all of them (gpu/renderer.ts).

import { requestGpuDevice } from '../render/select';
import type { RendererOptions } from '../render/types';

declare global {
  interface Window {
    /** WebGPU validation and out-of-memory errors so far (harnesses assert 0). */
    __gpuErrors?: number;
  }
}

/**
 * Installs error counting on a device. The count is kept across devices, so
 * a device re-created after a loss adds to the same total.
 */
export function watchErrors(device: GPUDevice): void {
  window.__gpuErrors ??= 0;
  device.onuncapturederror = (e) => {
    window.__gpuErrors = (window.__gpuErrors ?? 0) + 1;
    console.error(`WebGPU error: ${e.error.message}`);
  };
}

/**
 * A fresh device per the adapter policy (render/select.ts
 * `requestGpuDevice`), with error counting installed, or null when WebGPU is
 * unavailable here. Used to recover from a device loss.
 */
export async function openDevice(opts: RendererOptions): Promise<GPUDevice | null> {
  const device = await requestGpuDevice<GPUDevice>(navigator.gpu, opts);
  if (device) watchErrors(device);
  return device;
}

/** A short label for an adapter: vendor, architecture, and whether it is software. */
export function describeAdapter(info: GPUAdapterInfo): string {
  const name = [info.vendor, info.architecture].filter((s) => s !== '').join(' ') || 'unknown adapter';
  return info.isFallbackAdapter ? `${name} (software)` : name;
}
