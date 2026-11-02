// The canvas the WebGPU renderer draws into, and its MSAA colour texture.
//
// WebGPU concepts used here:
// - `canvas.getContext('webgpu')` gives a *canvas context*. It does nothing
//   until `configure()` ties it to a device and a texture format. Each frame,
//   `getCurrentTexture()` hands out the texture that will be shown; once the
//   task that drew into it ends, the browser presents it and the next call
//   returns a fresh one. Its size follows `canvas.width/height`.
// - The format comes from `navigator.gpu.getPreferredCanvasFormat()`:
//   `bgra8unorm` or `rgba8unorm` depending on the platform. Both are plain
//   (non-sRGB) 8-bit, matching how WebGL writes colours.
// - `alphaMode: 'premultiplied'` composites the canvas over the page using
//   its alpha, as the WebGL context did (`premultipliedAlpha: true`).
// - Multisampling: WebGL's `antialias: true` gave a 4× MSAA drawing buffer
//   for free. Here it is explicit: we draw into our own 4-sample texture
//   and the render pass *resolves* (averages) it into the canvas texture at
//   the end. The MSAA texture is re-created when the canvas size changes.

import { SAMPLE_COUNT } from './pipelines';

export class CanvasTarget {
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  private readonly device: GPUDevice;
  private readonly canvas: HTMLCanvasElement;
  private msaa: GPUTexture | null = null;

  /** `format` is `navigator.gpu.getPreferredCanvasFormat()`, also baked into the pipelines. */
  constructor(device: GPUDevice, canvas: HTMLCanvasElement, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device;
    this.canvas = canvas;
    this.context = context;
    this.format = format;
    context.configure({
      device,
      format: this.format,
      alphaMode: 'premultiplied',
      // COPY_SRC lets readback.ts copy the frame out (precision test, parity).
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  /** Drawing-buffer size in device px. */
  size(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  /**
   * The colour attachment for this frame: draw into the MSAA texture, clear
   * it to transparent black first, resolve into the canvas texture at the
   * end and throw the samples away (`storeOp: 'discard'`) — only the
   * resolved image is needed.
   */
  colourAttachment(): GPURenderPassColorAttachment {
    const { width, height } = this.size();
    if (!this.msaa || this.msaa.width !== width || this.msaa.height !== height) {
      this.msaa?.destroy();
      this.msaa = this.device.createTexture({
        label: 'msaa colour',
        size: { width, height },
        format: this.format,
        sampleCount: SAMPLE_COUNT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    return {
      view: this.msaa.createView(),
      resolveTarget: this.context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear',
      storeOp: 'discard',
    };
  }

  destroy(): void {
    this.msaa?.destroy();
    this.msaa = null;
    this.context.unconfigure();
  }
}
