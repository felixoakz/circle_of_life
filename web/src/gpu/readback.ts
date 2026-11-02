// Copying a frame from the GPU back to JS (the precision test, parity).
//
// WebGPU concepts used here:
// - JS cannot read a texture directly. A *command encoder* records a
//   `copyTextureToBuffer` into a buffer created with `MAP_READ`; the
//   commands go to the GPU with `queue.submit`, and `buffer.mapAsync`
//   resolves once the GPU has written it, after which `getMappedRange()`
//   is an ArrayBuffer view of its bytes.
// - Copies need each row to start on a 256-byte boundary, so rows are
//   padded (`paddedBytesPerRow`) and the padding is stripped afterwards.
// - The canvas format may be `bgra8unorm`: the bytes then need swapping to RGBA.
// - The canvas texture is only valid until the browser presents it at the
//   end of the task, so the copy is encoded in the same task as the draw.

import { type CanvasFormat, paddedBytesPerRow, readbackToPixels } from '../render/pixels';
import type { Pixels } from '../render/types';

function canvasFormat(f: GPUTextureFormat): CanvasFormat {
  if (f === 'rgba8unorm' || f === 'bgra8unorm') return f;
  throw new Error(`readback: unsupported canvas format ${f}`);
}

/** Top-down RGBA pixels of `texture` (the canvas texture of the frame just drawn). */
export async function readTexture(device: GPUDevice, texture: GPUTexture): Promise<Pixels> {
  const { width, height } = texture;
  const bytesPerRow = paddedBytesPerRow(width);
  const buffer = device.createBuffer({
    label: 'readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'readback' });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  try {
    await buffer.mapAsync(GPUMapMode.READ);
    // readbackToPixels copies the rows out before `finally` destroys (and unmaps) the buffer.
    const mapped = new Uint8Array(buffer.getMappedRange());
    return readbackToPixels(mapped, width, height, bytesPerRow, canvasFormat(texture.format));
  } finally {
    buffer.destroy();
  }
}
