# The WebGPU renderer

How the tree is drawn with WebGPU, written for a web developer learning WebGPU. The plan it was built from is `docs/plan-webgpu.md`; the code is `web/src/render/` (backend-neutral), `web/src/gpu/` (WebGPU) and `web/src/gl/` (WebGL2). Every file in `web/src/gpu/` opens with a comment explaining the WebGPU concepts it uses, so reading them in the order below works as a course:

1. `device.ts`: adapter, device, errors, loss
2. `target.ts`: canvas context, formats, MSAA
3. `layout.ts`, `uniforms.ts`: buffer layout rules, packing
4. `pipelines.ts`: shader modules, render pipelines, bind group layouts
5. `tiles.ts`, `shaders/tile.wgsl`: vertex pulling from storage buffers
6. `renderer.ts`: command encoder, render pass, dynamic offsets, device-loss recovery
7. `readback.ts`: copying a texture back to JS
8. `timing.ts`: optional features, timestamp queries, async mapping
9. `parity.ts`, `shaders/parity.wgsl`: compute pipelines, workgroups, storage buffers, readback

## 1. Architecture

### One interface, two backends

Everything above the GPU (scene, labels, hover, panel) talks to one interface, `Renderer` in `render/types.ts`:

```ts
interface Renderer {
  readonly kind: 'webgpu' | 'webgl2';
  upload(tile: Tile): GpuTile;      release(tile: GpuTile): void;
  setFans(data: Uint32Array): void;
  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats;
  size(): { width: number; height: number };
  finish(): Promise<void>;          // GPU done (bench, debug HUD)
  readPixels(): Promise<Pixels>;    // the frame just drawn, top-down RGBA
  gpuMs(): number | null;           // last GPU frame time, when measurable
  onLost / onRestored / loseDevice?; destroy();
}
```

`WebGpuRenderer` (`gpu/renderer.ts`) and `WebGl2Renderer` (`gl/renderer.ts`) implement it. Nothing outside `gl/` knows about WebGL and nothing outside `gpu/` knows about WebGPU.

### The shared frame plan

The WebGL2 renderer used to make dozens of small decisions inside `draw`: which tiles to skip at fade 0, how many segments an arc gets, where the fans split into wide and narrow, which highlight paths to draw. Two backends making those decisions separately would drift. So `render/plan.ts` has one pure function:

```ts
planFrame(tiles, fans, params, size, passes) → { look, cmds: DrawCmd[], stats }
```

Each `DrawCmd` names a pass (`fans`, `branches`, `arcs`, `rim`, `marks`, `dim`, `path`, `ring`), its vertex and instance counts, the tile or data it reads, its per-draw values and its blend mode. A backend only executes commands. The plan has 470 lines of tests (`render/plan.test.ts`), and both backends draw the same frames because they execute the same list.

### Selection and fallback

`render/select.ts` picks the backend before any canvas context exists. That ordering is required: once a canvas has given a `webgpu` context it can never give `webgl2`.

| URL / situation | Order tried |
|---|---|
| default | WebGPU (hardware adapter only), then WebGL2 |
| `?renderer=webgpu` | WebGPU (a software adapter is accepted, with a warning), then WebGL2 |
| `?renderer=webgl` | WebGL2 |
| `?nowebgl` | none: the fallback page (still image, search, panel) |
| WebGPU lost earlier this session (memo in `sessionStorage`) or no `navigator.gpu` | WebGL2 |
| both fail | the fallback page |

A software adapter (`adapter.info.isFallbackAdapter`, e.g. SwiftShader) is refused by default: WebGL2 on the real GPU is much faster than WebGPU on the CPU. `window.__renderer` always says which backend won; the harnesses assert it.

### Lazy chunks

Each backend is a dynamic `import()`, so a visit downloads only the one it uses. The WebGPU factory asks for an adapter and device first and imports the WebGPU chunk only when it got one. Debug aids (`debug.ts`, `gpu/parity.ts`) are lazy too.

| Chunk | gzip |
|---|---|
| initial `index` (app, select, plan types) | 39.87 KB (+0.46 KB shared `angle`) |
| WebGL2 renderer | 13.47 KB |
| WebGPU renderer + shared WGSL (`renderer` + `pipelines`) | 3.42 + 14.81 KB |
| shared plan | 1.54 KB |
| shared pixel helpers (`render/pixels`) | 0.65 KB |
| `?debug` | 1.15 KB |
| `?debug=parity` | 4.63 KB |

## 2. GLSL → WGSL

WGSL has no `#include`. `gpu/pipelines.ts` builds each shader module by concatenation: the generated structs (§3), then `common.wgsl`, `palette.wgsl`, `frag.wgsl`, `tile.wgsl`, then the pass's own file (`withShared`). The parity page compiles `parity.wgsl` the same way, so it tests the exact functions the tree uses.

| GLSL (`gl/shaders/`) | WGSL (`gpu/shaders/`) | Pipeline: topology, blend |
|---|---|---|
| `common.glsl` | `common.wgsl`: `polarToClipOffset`, `sinPrecise`, `clampedPoint` (returns a struct), `childFade`, `ss()` | shared |
| `palette.glsl` | `palette.wgsl`: `kingdomColour`, `runLen` | shared |
| `frag.glsl` | `frag.wgsl`: `revealMask`, `tint`, `rimBoost`, `extRamp`, `hash`, `strands` | shared |
| vertex attributes | `tile.wgsl`: `tileAngle(i)`, `tileR(i)`, `tileU8(k, i)`… | shared |
| `branches.vert` + `line.frag` | `lines.wgsl` `vs_branches`, `fs_line` | line-list, saturating |
| `arcs.vert` + `line.frag` | `lines.wgsl` `vs_arcs`, `fs_line` | line-list, saturating |
| fans | `fans.wgsl` | triangle-list, saturating, `firstInstance` |
| rim | `rim.wgsl` | triangle-list, saturating |
| marks | `marks.wgsl` | triangle-strip, additive `(one, one)` |
| path | `path.wgsl` | triangle-list, over `(one, one − src-alpha)` |
| ring | `ring.wgsl` | triangle-strip, over |
| dim | `dim.wgsl` | triangle-list, dim `(zero, one − src-alpha)` |

"Saturating" is `src: one-minus-dst-alpha, dst: one` for colour and alpha. WebGL set blend modes as global switches before each draw; in WebGPU blending is baked into the pipeline, so there is one pipeline per pass.

### Language differences

| GLSL | WGSL |
|---|---|
| `float x = 1.0;` | `let x: f32 = 1.0;` (`let` immutable, `var` mutable) |
| `vec3`, `uvec4` | `vec3f`, `vec4u` |
| implicit `int`→`float` | never: `f32(i)`, `u32(x)` |
| `uniform float uScale;` | fields of a `struct`, bound as `var<uniform> frame: Frame` |
| `void f(out uint a)` | return a struct (`ArcPoint { ok, a }`) |
| `const float STEP[6] = …;` indexed at run time | function-local `var` array |
| `gl_FragCoord` (y up) | `@builtin(position)` (y down): the y flip in `dim` went away |
| `gl_InstanceID` + attribute pointers | `@builtin(instance_index)`, data read from storage |
| `#include` | concatenation in TS |

### Hazards met

- **Infinity.** `uReveal = Infinity` after the intro made `smoothstep(inf − s, inf, r)` NaN in WGSL, which may assume floats are finite. Both backends now get a finite sentinel (`REVEAL_DONE = 1e4`, `render/plan.ts`).
- **Reversed smoothstep.** `smoothstep(1, 0, x)` is undefined in WGSL (fine on most GLSL drivers). All of them go through `ss(e0, e1, x)` in `common.wgsl`; `shaders.test.ts` rejects a literal reversed `smoothstep(`.
- **u32 maths.** Subtraction wraps exactly as in GLSL, but a constant expression that overflows (`0u - 1u`) is a compile error.
- **`sin` accuracy.** WGSL only promises 2⁻¹¹ absolute accuracy for `sin`. For tiny angles that is useless (relative error up to 100%; the parity page shows SwiftShader's `sin` returning 0 there), so `sinPrecise` uses a Taylor series below 0.1 rad.

## 3. Uniforms: one field list, two outputs

WGSL buffer layout has rules that are easy to get wrong by hand: `vec2` aligns to 8 bytes, `vec3` and `vec4` to 16 (a scalar can sit in the 4 bytes after a `vec3`), uniform array elements need a 16-byte stride, and a struct's size rounds up to its largest alignment.

`gpu/layout.ts` encodes those rules once. A struct is a TS field list:

```ts
export const FRAME_FIELDS = [['camA', 'u32'], ['camFrac', 'f32'], ['camR', 'vec2f'], …];
```

`structLayout(fields)` computes each field's offset; `wgslStruct(name, layout)` **generates the WGSL `struct` text** that is prepended to every module. The packers in `gpu/uniforms.ts` write values at those offsets, so TS and WGSL cannot disagree. Tests snapshot the offsets and the generated text.

Bind groups are split by how often they change:

| Group | Contents | Changes |
|---|---|---|
| 0 | `Frame` (camera, look; 128 B) and `Palette` (run starts, colours) | once per frame / once per session |
| 1 | one 256-byte slot of the per-draw buffer (`LinesDraw`, `MarksDraw`…) | per draw, by **dynamic offset** |
| 2 | a storage buffer: a tile, the fans, or one highlight path | per draw |

All per-draw structs of a frame are written into one CPU `ArrayBuffer` and uploaded with a single `writeBuffer`; each draw then calls `setBindGroup(1, group, [slot * 256])`. 256 is `minUniformBufferOffsetAlignment` on every adapter.

## 4. Vertex pulling

Tiles are binary blobs (`docs/tile-format.md`) with some 1-byte-per-node arrays (`group`, `flags`, `childLevel`). WebGPU vertex buffers need strides that are multiples of 4, so they could not be fed in as attributes without copying. Instead the whole tile, minus its names, is one read-only **storage buffer**, and the vertex shader reads node `instance_index` from it (`tile.wgsl`):

```wgsl
@group(2) @binding(0) var<storage, read> tile: array<u32>;
fn tileU8(k: u32, i: u32) -> u32 {
  let b = 24u + (36u + k) * tileN() + i;            // byte offset
  return (tile[b >> 2u] >> ((b & 3u) * 8u)) & 0xffu;  // pick the byte from its word
}
```

Upload is still zero-copy (`writeBuffer` straight from the fetched `ArrayBuffer`). `gpu/tiles.ts` mirrors the index maths in TS and is tested against the tile decoder.

## 5. MSAA, readback, crossfade

WebGL's `antialias: true` gave 4× MSAA for free. In WebGPU it is explicit (`gpu/target.ts`): the render pass draws into our own 4-sample texture (`storeOp: 'discard'`) and *resolves* it into the canvas texture. The MSAA texture is re-created when the canvas size changes (at the 6 Mpx cap it is about 96 MB).

The canvas texture is only valid until the browser presents it at the end of the task. So `readPixels` (precision test, smoke) copies it in the same task as the draw (`copyTextureToBuffer`, rows padded to 256 bytes, BGRA swizzled when the platform prefers `bgra8unorm`), and the reduced-motion crossfade's `drawImage` of the tree canvas also happens in the drawing task. Both work.

## 6. Device loss

A device can be lost (driver reset, GPU process crash). `device.lost` resolves once; every buffer, texture and pipeline it made is dead.

1. All device-owned objects live in one `DeviceState` (`gpu/renderer.ts`). On a loss that we did not cause with `destroy()`, frames are skipped, a new adapter and device are requested, and pipelines, buffers, fans and path slots are rebuilt. Then `onRestored` makes the scene re-upload every resident tile (`TileCache.rebuild()`).
2. That happens once per page. A second loss, or a failed recovery, calls `onLost`: the app stores a memo in `sessionStorage` and reloads with `?renderer=webgl`, keeping the selection (`n`) and the live camera (`v`).
3. Validation errors do not throw; they arrive on `device.onuncapturederror`. They are counted in `window.__gpuErrors`, and every harness asserts 0.

`?debug` exposes `window.__loseDevice()`; the smoke test uses it twice (recover in place, then reload into WebGL2).

## 7. Instrumentation

**GPU frame time** (`gpu/timing.ts`). When the adapter offers `timestamp-query`, `requestGpuDevice` asks for it. With `?debug` or `?shot`, the tree pass writes begin/end timestamps into a 2-entry query set; the frame's encoder resolves them into a buffer and copies them to one of three `MAP_READ` buffers, which are mapped asynchronously. Nothing waits for them: if all three are still in flight, that frame is not timed. `renderer.gpuMs()` is the last value, `finish()` also waits for outstanding reads, and `__bench(n)` returns `{ ms, gpuMs }`, the average wall time and GPU time over n frames. The debug HUD shows `frame … ms  gpu … ms  webgpu`. On WebGL2 `gpuMs()` stays `null` (`EXT_disjoint_timer_query_webgl2` is not exposed by Chrome without flags).

**Compute parity page** (`?debug=parity`, `gpu/parity.ts`). It opens its own device (any adapter, software included), compiles `parity.wgsl` with the shared modules, and runs five compute entry points on fixed inputs. Each invocation reads one 4-word input from a storage buffer and writes one `vec4f`; the output buffer is copied to a mapped buffer and compared in TS. The result is `window.__gpuParity = { ok, adapter, results }` and a HUD line.

| Check | Reference | Inputs | Tolerance |
|---|---|---|---|
| `kingdomColour` (overview and mid-zoom seams) | `RunPalette.colourAt` | every run start, ±0.1–0.45 seam widths around it, 256-step sweep | 1/1024 per sRGB channel, at an angle within one float32 step of the run length (the shader measures the angle from the run start as an f32; at mid zoom that step is ≤ 0.08 px) |
| `polarToClipOffset` (overview, mid zoom, max zoom, max zoom straddling angle 0) | `Camera.polarToScreen` in doubles plus the rotated offset | 9 × 7 screen grid, with and without an offset | 0.05 px; plus 2·2⁻¹¹·r·scale where the built-in `sin` is used (|Δθ| ≥ 0.1, only when zoomed out) |
| `hash` | lowbias32 with `Math.imul` | edge values + 506 random u32 | one f32 step (2⁻²⁴) |
| `strands` (overview and max zoom) | double port | 256 random (units, px), skipping inputs within 1% of a cell or octave edge | hashes 2⁻²⁴, weight 1e-5 |
| `sinPrecise` | `Math.sin` | log-spaced 1e-9…3.1, both signs | 1e-6 relative below 0.1, 2⁻¹¹ absolute above |

`parityRef.test.ts` checks the references themselves (the double port of the shader formula equals `polarToScreen` to 1e-4 px; `hashRef` equals a BigInt lowbias32).

Results on SwiftShader (2026-10-31): **all 13 checks ok.** Notable numbers: polar error 1e-4 px at max zoom (the hi/lo camera split works), 0.37 px at the overview's far edges (built-in `sin`, inside its budget); built-in `sin` on tiny angles has relative error 1.0, which is why `sinPrecise` exists.

## 8. Testing

| What | How | Notes |
|---|---|---|
| Unit tests (no GPU) | `make check` (vitest) | plan, select policy, layout/uniform packing, tile index maths, WGSL static checks (`MAX_RUNS`, reversed smoothstep, entry points exist), pixel helpers, parity references |
| WebGL unchanged | `SHOT_GPU=1 SHOT_COMPARE=../screens/baseline-webgl-gpu pnpm -C web shot <states>` | bit-identical (0 / 0) on all 13 states after W6 |
| WebGPU vs WebGL pixels | `SHOT_RENDERER=both pnpm -C web shot` or `make shot-parity` | per-pass diffs (`SHOT_QUERY='&passes=fans'`) were under threshold in W4 |
| Precision | `?debug=precision` state of `shot.ts` | `window.__precision` |
| Compute parity | `pnpm -C web parity` (`SHOT_BASE` as for shot) | exits 1 on any failure |
| Smoke | `make smoke`, `SMOKE_WEBGPU=1 make smoke` | default, `?renderer=webgl`, `?renderer=webgpu&debug` (with two forced losses), `?nowebgl` |

Headless flags for WebGPU: `--enable-unsafe-webgpu --use-angle=gl --enable-gpu --ignore-gpu-blocklist` (appendix A explains why). `shot.ts`, `smoke.ts` (with `SMOKE_WEBGPU=1`) and `parity.ts` use them.

Debug URL flags: `?renderer=webgl|webgpu`, `?nowebgl`, `?debug`, `?debug=precision`, `?debug=parity`, `?passes=branches,arcs,…` (draw only those passes, both backends).

## 9. Performance

Measured 2026-10-31 with `__bench` (wall time per frame, waiting for the GPU after each; 60 frames, except 3 for WebGL on SwiftShader). Columns are labelled by **where the work ran**.

| State | WebGL2, AMD iGPU (hardware, `SHOT_GPU=1`) | WebGL2, SwiftShader (software, W0) | WebGPU, SwiftShader (software) wall | WebGPU, SwiftShader GPU time (timestamps) |
|---|---|---|---|---|
| overview | 3.56 | 514 | 674 | 670 |
| animals | 3.15 | 281 | 367 | 364 |
| mammals | 6.50 | 360 | 447 | 443 |
| deep-homo | 1.34 | 172 | 214 | 210 |
| key-fungi | 4.11 | 509 | 646 | 641 |
| crumb-fly | 1.51 | 171 | 214 | 211 |
| hidpi-overview (2560×1440 @2) | 7.84 | 800 | 1013 | 1001 |
| reduced | 4.04 | 529 | 678 | 674 |
| mobile-overview (390×844 @2) | 2.40 | 349 | 473 | 469 |
| mid-l6.5-protists | 5.76 | 296 | 367 | 363 |
| deep-archaea | 1.48 | 159 | 202 | 199 |
| panel-homo | 1.46 | 177 | 227 | 223 |
| hover-path | 7.61 | 373 | 460 | 455 |
| precision | 1.63 | 179 | 216 | 213 |

- **Hardware WebGL2** stays within the 8 ms budget everywhere (worst: hidpi-overview 7.8 ms, hover-path 7.6 ms), the same as W0.
- **WebGPU numbers are software only.** SwiftShader WebGPU is 1.2–1.4× slower than SwiftShader WebGL here; that compares two CPU rasterisers (Dawn on SwiftShader Vulkan vs ANGLE's SwiftShader GL) and says nothing about the GPU. Timestamp GPU time is within 1–4 ms of the wall time, so the frame is entirely raster work and CPU encoding is negligible.
- **Pending:** WebGPU on the AMD iGPU (target ≤ WebGL per state and ≤ 8 ms) and `?debug=precision` on it (target ≤ 0.25 px) need `vulkan-radeon`; commands in §10.
- Precision this run: WebGL2 on the iGPU max 0.2152 px, 0 unmatched (unchanged); WebGPU on SwiftShader max 0.5143 px, mean 0.0059, 0 unmatched (same as W4; see §10).

## 10. Known gaps

- **No Vulkan driver on this machine.** Chrome on Linux runs WebGPU on hardware only through Vulkan, and `/usr/share/vulkan/icd.d` does not exist (no `vulkan-radeon`). Every WebGPU number here is SwiftShader, a CPU implementation. Real-GPU WebGPU frame times and precision are pending:
  ```sh
  sudo pacman -S vulkan-radeon
  ls /usr/share/vulkan/icd.d            # radeon_icd.x86_64.json should appear
  make build                            # web/dist + bin/species
  bin/species serve --data data --static web/dist --port 3078 &
  # The WebGPU flags pick the hardware adapter once Vulkan is there; check "adapter" in screens/webgpu/*.json.
  SHOT_BASE=http://localhost:3078 SHOT_GPU=1 SHOT_RENDERER=both pnpm -C web shot \
    overview animals mammals deep-homo key-fungi crumb-fly hidpi-overview reduced \
    mobile-overview mid-l6.5-protists deep-archaea panel-homo hover-path precision
  SHOT_BASE=http://localhost:3078 pnpm -C web parity
  ```
  Targets: WebGPU `frameMs` ≤ WebGL per state and ≤ 8 ms; precision max ≤ 0.25 px (WebGL on the iGPU: 0.2152). If the hardware adapter does not appear headless, try adding `--enable-features=Vulkan --use-angle=vulkan` (W0 flag matrix, appendix A).
- **Precision outlier on SwiftShader.** `?debug=precision` on SwiftShader WebGPU gives max 0.51 px (mean 0.006 px, 0 unmatched), above the 0.25 px target; WebGL on SwiftShader gives 0.33 px (mean 0.006) and WebGL on the iGPU 0.215. It is rasterisation, not maths: the parity page measures the transform at max zoom on the same SwiftShader adapter at 1e-4 px, and the mean is the same as WebGL's. The max is one line crossing where SwiftShader's hairline coverage (Dawn `line-list` with 4× MSAA vs ANGLE GL lines) rounds differently in the two frames. Judge precision on the hardware run above.
- **Pixel parity is cross-rasteriser.** Headless WebGPU (SwiftShader) is compared against WebGL on the AMD GL driver, so full frames differ by the same 0.2–2.8% "over" that two rasterisers give on identical WebGL code (W0 noise floor); per pass they were under threshold.
- **No WebGL GPU timer.** `gpuMs()` is null on WebGL2.
- **Not checked by hand:** Safari and Firefox WebGPU (WGSL portability), Chrome on Windows/macOS.

---

## Appendix A: W0 probe (2026-10-30)

Machine: AMD Barcelo iGPU (Renoir, `radeonsi`), Arch Linux, Mesa 26.2.5. Playwright 1.64.1 = Chromium 156.0.8078.4.

### The one fact that decides everything

**This machine has no Vulkan driver for its GPU.** `vulkan-icd-loader` is installed, but no ICD (no `vulkan-radeon`, `/usr/share/vulkan/icd.d/` does not exist). Chrome on Linux only runs WebGPU on hardware through Vulkan, so every WebGPU adapter here is **SwiftShader** (Google's CPU Vulkan, bundled with Chromium as `libvk_swiftshader.so`): `vendor: google, architecture: swiftshader, isFallbackAdapter: true`.

To get hardware WebGPU on this machine: `sudo pacman -S vulkan-radeon`, then rerun the probe. Desktop Chrome on this machine has the same limit; check `chrome://gpu` ("WebGPU" row) after installing the driver. Not checked here, since it needs your own browser.

### Flag matrix

Each config ran in a fresh Playwright browser on a `http://localhost` page. `navigator.gpu` exists only in secure contexts, so the probe returns `false` on `about:blank`. The probe requests an adapter and a device, clears a 64×64 canvas to (255,128,64), copies it out with `copyTextureToBuffer`, maps the buffer and checks the pixel. A second check takes a `page.screenshot()` of a WebGPU canvas, 3 runs each.

"shell" = Playwright's default `chromium_headless_shell`; "new" = `channel: 'chromium'` (new headless mode in the full browser).

| Flags | Shell | New | Adapter | Device | Canvas clear + readback + screenshot |
|---|---|---|---|---|---|
| none | yes | yes | `null` ("No available adapters") | – | – |
| `--enable-unsafe-webgpu` | yes | yes | SwiftShader (fallback) | ok | **crash**¹ |
| (b) SwiftShader Vulkan²: `forceFallbackAdapter: true` | shell | | SwiftShader | ok | **crash**¹ |
| (b) SwiftShader Vulkan², no force | shell | | SwiftShader | ok | **crash**¹ |
| (b) SwiftShader Vulkan², with or without force | | new | `null` | – | – |
| current shot flags (`--use-angle=swiftshader --enable-unsafe-swiftshader`) + `--enable-unsafe-webgpu` | yes | yes | SwiftShader | ok | **crash**¹ |
| (c) real GPU Vulkan³ | shell | | SwiftShader | ok | **crash**¹ |
| (c) real GPU Vulkan³ | | new | `null` | – | – |
| **`--enable-unsafe-webgpu --use-angle=gl`** (± `--enable-gpu --ignore-gpu-blocklist`) | yes | yes | SwiftShader | ok | **ok**, 3/3, pixel exact |
| `--enable-unsafe-webgpu --use-angle=gl-egl` | yes | | SwiftShader | ok | ok, 3/3 |
| `--use-angle=gl` + `--use-webgpu-adapter=opengles` | | new | SwiftShader (no GL adapter offered) | ok | ok |

¹ The adapter and device work, and rendering into a plain `createTexture` texture reads back correctly in every config. The crash comes only with a **canvas** (`getContext('webgpu')`): `mapAsync`/`getCurrentTexture` fail with "A valid external Instance reference no longer exists" and the device is lost. Sharing the canvas image with the compositor fails unless ANGLE runs on native GL.
² `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader`.
³ `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist`.

Every working adapter offers `timestamp-query`, and its preferred canvas format is `rgba8unorm` (desktop Chrome usually picks `bgra8unorm`, so readback has to handle both, as plan §2.3 says). For a cost estimate: a 1440×900 4× MSAA clear + resolve takes about 2 ms per frame on SwiftShader WebGPU.

### Chosen headless flags

```
--enable-unsafe-webgpu --use-angle=gl --enable-gpu --ignore-gpu-blocklist
```

That is today's `SHOT_GPU=1` set plus `--enable-unsafe-webgpu`, in the default headless shell (`channel: 'chromium'` is not needed). In this browser:

- **WebGL2** runs on the AMD iGPU (`ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir ACO), OpenGL ES 3.2)`), as in `SHOT_GPU=1` today.
- **WebGPU** runs on SwiftShader (a CPU Vulkan) with `isFallbackAdapter: true`. The plan rejects fallback adapters by default (§8.2), so harnesses must load `?renderer=webgpu`.

What this means for plan §5:

- Headless WebGPU **exists but needs the host's GL driver** (it uses the iGPU through Mesa, so it is not GPU-free). Today's SwiftShader-only WebGL mode (`--use-angle=swiftshader`) cannot also run WebGPU. A GPU-less CI box would get no WebGPU canvas at all.
- WebGPU **parity** runs headless, but it compares two different rasterisers: SwiftShader (WebGPU) against AMD GL (WebGL). The plan's `overPct ≤ 0.5%` threshold is tighter than the gap between those two rasterisers on the *same* WebGL code (table below). W2/W3 should either compare WebGPU-SwiftShader against a WebGL-SwiftShader baseline from a second browser (the existing default flags), or calibrate the threshold to the cross-rasteriser gap.
- WebGPU **perf** numbers measured headless are SwiftShader numbers. The "≤ 8 ms on the AMD iGPU" goal (W6) needs `vulkan-radeon` installed first.
- **Precision** on WebGPU runs on SwiftShader float maths, not real GPU maths, until the driver is installed.

### WebGL baselines

Shot with `web/scripts/shot.ts` against `species serve --port 3078`, states: DEFAULTS (`overview animals mammals deep-homo key-fungi crumb-fly precision`) plus `hidpi-overview mobile-overview reduced hover-path panel-homo mid-l6.5-protists deep-archaea`. All the requested names exist in `shot.ts`.

- `screens/baseline-webgl/`: SwiftShader (default flags)
- `screens/baseline-webgl-gpu/`: `SHOT_GPU=1` (AMD iGPU through ANGLE GL)

Frame times (`__bench`, ms; SwiftShader 3 frames, GPU 60 frames; run 1 / run 2):

| State | SwiftShader | GPU |
|---|---|---|
| overview | 514 / 527 | 3.5 / 4.0 |
| animals | 281 / 292 | 3.0 / 3.0 |
| mammals | 360 / 359 | 6.4 / 6.8 |
| deep-homo | 172 / 171 | 1.4 / 1.4 |
| key-fungi | 509 / 530 | 4.1 / 4.0 |
| crumb-fly | 171 / 171 | 1.4 / 1.4 |
| hidpi-overview | 800 / 826 | 7.9 / 7.8 |
| reduced | 529 / 520 | 3.9 / 3.8 |
| mobile-overview | 349 / 337 | 2.4 / 2.4 |
| mid-l6.5-protists | 296 / 300 | 5.2 / 5.4 |
| deep-archaea | 159 / 154 | 1.6 / 1.4 |
| panel-homo | 177 / 176 | 3.6 / 1.4 |
| hover-path | 373 / 366 | 7.5 / 7.2 |
| precision | 179 / 177 | 1.6 / 2.1 |

Precision test: GPU max 0.2152 px, mean 0.00018, 0 unmatched (both runs). SwiftShader max 0.3341 px, mean 0.0058, 1 unmatched (both runs). The plan's 0.215 px target is the GPU number.

### Noise floor

The same 14 states were shot twice in each mode and compared per pixel: `over%` is the share of pixels whose largest channel difference is > 16, `meanAbs` the mean absolute difference over all RGBA channels.

| Comparison | All states except `precision` | `precision` |
|---|---|---|
| SwiftShader run 1 vs run 2 | **0 / 0** (bit-identical) | 0.0055% / 0.0032 |
| GPU run 1 vs run 2 | **0 / 0** (bit-identical) | 0.137% / 0.091 |

The `precision` state is not stable between runs: its frame depends on when the screenshot lands after the jitter test. Leave it out of parity diffs; its JSON result is the thing to compare.

For scale, the same WebGL code on the two rasterisers (SwiftShader run 1 vs GPU run 1) differs by 0.16–1.76% over / 0.14–0.64 meanAbs (worst: `mid-l6.5-protists` 1.76% / 0.64, `mobile-overview` 1.29%, `animals` 1.14%; best: `hover-path` 0.16%, `deep-homo` 0.25%). This is the gap a SwiftShader-WebGPU vs GPU-WebGL comparison would start from before any shader differences.

### TypeScript

- `@webgpu/types` 0.1.74 is a devDependency of `web/` and listed in `tsconfig.json` `types`.
- TS 7.0.2 typechecks it cleanly. A probe file using `navigator.gpu`, `GPUDevice`, `adapter.info.isFallbackAdapter` and `getContext('webgpu')` compiled under the project's tsconfig, and a deliberate type error was caught, so the types are real and not `any`. No pin needed.
