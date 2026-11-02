// GPU frame time from timestamp queries (docs/plan-webgpu.md §2.5), for the
// `?debug` HUD and `__bench`.
//
// Why this is needed: `performance.now()` around `draw()` only measures the
// CPU recording commands. The GPU runs them later, on its own clock, so the
// time it spends drawing is invisible to JS unless the GPU itself writes
// timestamps.
//
// WebGPU concepts used here:
// - *Optional features.* `timestamp-query` is not guaranteed. The adapter
//   lists what it offers in `adapter.features`; a device only gets a feature
//   if `requestDevice({ requiredFeatures })` asked for it (render/select.ts
//   asks when it is offered), and `device.features` says what it got.
// - A *query set* (`createQuerySet({ type: 'timestamp', count: 2 })`) is a
//   tiny GPU-side array of 64-bit results. A render pass descriptor's
//   `timestampWrites` tells the GPU to write the time into slot 0 when the
//   pass begins and into slot 1 when it ends.
// - Query results live on the GPU. `resolveQuerySet` copies them into a
//   buffer made with the `QUERY_RESOLVE` usage, and from there
//   `copyBufferToBuffer` copies them into a `MAP_READ` buffer that JS can map.
//   Both are commands in the frame's encoder, so they run right after the pass.
// - *Mapping is asynchronous.* `mapAsync` resolves only once the GPU has
//   finished the frame. Waiting for it would stall the next frame, so we
//   never wait: each frame takes a free readback buffer from a small pool,
//   and the buffer goes back once its result has been read. If none is free
//   (the GPU is a few frames behind), that frame is simply not timed.
// - Timestamps are nanoseconds as `BigInt` (`BigUint64Array`). Browsers
//   round them (Chrome to 100 µs unless developer features are on) so
//   timing attacks cannot use them; fine for frame times in milliseconds.

/** Readback buffers in the pool: frames that can be in flight while still timed. */
const POOL_SIZE = 3;
/** Two u64 timestamps: begin and end of the pass. */
const RESULT_BYTES = 16;

/** Times one render pass per frame; read the latest result with `ms()`. */
export class GpuTimer {
  private readonly device: GPUDevice;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  /** Readback buffers not in use. */
  private readonly free: GPUBuffer[] = [];
  /** Every readback buffer made so far, to destroy them all. */
  private readonly all: GPUBuffer[] = [];
  /** The readback buffer of the frame being encoded, between `passWrites` and `submitted`. */
  private current: GPUBuffer | null = null;
  /** Results still being mapped. */
  private readonly reading = new Set<Promise<void>>();
  private last: number | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.querySet = device.createQuerySet({ label: 'frame time', type: 'timestamp', count: 2 });
    this.resolveBuffer = device.createBuffer({
      label: 'frame time resolve',
      size: RESULT_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
  }

  /** Whether `device` can time passes (it was given `timestamp-query`). */
  static supported(device: GPUDevice): boolean {
    return device.features.has('timestamp-query');
  }

  /**
   * The `timestampWrites` for this frame's render pass, or undefined when
   * every readback buffer is still waiting on an earlier frame.
   */
  passWrites(): GPURenderPassTimestampWrites | undefined {
    this.current = this.free.pop() ?? this.newBuffer();
    if (!this.current) return undefined;
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /** Encodes copying the pass's timestamps out, after the pass has ended. */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.current) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.current, 0, RESULT_BYTES);
  }

  /** Starts reading this frame's result back; call right after `queue.submit`. */
  submitted(): void {
    const buf = this.current;
    this.current = null;
    if (!buf) return;
    const read = buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const [begin, end] = new BigUint64Array(buf.getMappedRange());
        buf.unmap();
        // Rounded timestamps can make a very short pass look negative.
        if (begin !== undefined && end !== undefined && end >= begin) this.last = Number(end - begin) / 1e6;
        this.free.push(buf);
      })
      .catch(() => {
        // The device was lost or the timer destroyed: this result is gone.
      })
      .finally(() => this.reading.delete(read));
    this.reading.add(read);
  }

  /** GPU time of the last frame whose result came back, ms. */
  ms(): number | null {
    return this.last;
  }

  /** Resolves when every submitted frame's result has been read. */
  settled(): Promise<void> {
    return Promise.all(this.reading).then(() => undefined);
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    for (const b of this.all) b.destroy();
  }

  /** A new readback buffer while the pool is below POOL_SIZE, else null. */
  private newBuffer(): GPUBuffer | null {
    if (this.all.length >= POOL_SIZE) return null;
    const buf = this.device.createBuffer({
      label: 'frame time readback',
      size: RESULT_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.all.push(buf);
    return buf;
  }
}
