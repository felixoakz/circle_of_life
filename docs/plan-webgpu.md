# WebGPU renderer plan

Status: W0–W6 done (2026-10-31). WebGPU (WGSL) is the primary renderer; the existing WebGL2 renderer is the fallback behind one `Renderer` interface. No WASM, no libraries (raw WebGPU, `@webgpu/types`). Real-GPU WebGPU perf and precision still pending a Vulkan driver on the dev machine (`docs/webgpu.md` §10). Approved by supervisor 2026-10-30.

## 0. Findings that drive the design

**Renderer call sites today**
- `web/src/scene.ts`: `new Renderer(gl, palette)`, `upload`/`release` via `TileCache<GpuTile>`, `setFans(buildFans(...))`, `draw(tiles, FrameParams) → FrameStats`, `waitForGpu()` (1×1 `gl.readPixels`, used by `bench`/`syncGpu`).
- `web/src/main.ts`: `createGL`, `fitCanvas`, `treeDpr`, `runPrecisionTest(scene, gl)`.
- `web/src/debug.ts`: `runPrecisionTest` reads `gl.drawingBufferWidth` and full `gl.readPixels` (rows bottom-up).
- `selection.ts`, `hover.ts`: type imports only (`PathDraw`, `RingDraw`).

**Passes in `Renderer.draw`** (`web/src/gl/renderer.ts`)

| Pass | Primitive | Draws | Blend |
|---|---|---|---|
| fans | TRIANGLES, 6K verts/instance | 2 draws (K=16 wide, K=2 narrow; `fansWiderThan` binary search; attributes re-pointed since GL lacks base instance) | saturating `(1−dstA, 1)` |
| branches | LINES, 4 verts/instance | per tile | saturating |
| arcs | LINES, 2K verts | per tile; K=128 if level ≤ 3, else 16 | saturating |
| rim | TRIANGLES 6·256, no attributes | 1 | saturating |
| marks | TRIANGLE_STRIP 4/instance | per tile | `(1, 1)` |
| treeDim | dim program, full screen | 1 | `(0, 1−srcA)` |
| path | TRIANGLES 6·64/segment | per path slot | `(1, 1−srcA)` |
| ring | TRIANGLE_STRIP 4 | per ring | `(1, 1−srcA)` |
| dims | TRIANGLES 6 | per rect | `(0, 1−srcA)` |

Clear (0,0,0,0); context `alpha, premultipliedAlpha, antialias: true`. All lines are 1-device-px `gl.LINES` (no `lineWidth`); paths and rings are already AA quads. So WebGPU `line-list` (1 px only) is a direct match; no wide-line emulation.

**Tile layout** (`tiles/decode.ts`, `docs/tile-format.md`): u8 arrays (`group`, `flags`, `childLevel`) have 1-byte stride, which WebGPU vertex buffers can't take (stride must be a multiple of 4). Decision: **vertex pulling**. Bind tile bytes `[0, nameOff)` as `var<storage, read> tile: array<u32>`, index by `instance_index`. `n = tile[3]`; `angle[i]` is word `6 + 2n + i`; u8 at byte `b` = `(tile[b>>2] >> ((b&3)*8)) & 0xff`; f32 via `bitcast<f32>`. Zero-copy upload stays.

**Shader hazards**
- `uReveal = Infinity` after the intro → `smoothstep(inf−s, inf, r)` = NaN; WGSL may assume no inf/NaN. Fix: finite sentinel (1e4) packed on the CPU, for both backends.
- Reversed `smoothstep` edges in `rimBoost` (1→0), `extRamp` (3→0.5), `marks.frag` (1→0.97). Use one explicit `ss(e0,e1,x)` helper in `common.wgsl`: `t=clamp((x−e0)/(e1−e0),0,1); t*t*(3−2t)`.
- `out` params (`clampedPoint(..., out uint a)`) → return a struct `{ ok: bool, a: u32 }`.
- Const arrays indexed at runtime (`STEP[6]`, `OUTER[6]`) → function-local `var` arrays.
- `gl_FragCoord` is y-up, `@builtin(position)` y-down: the y-flip in `dim.frag` goes away.
- u32 wrapping of `a − uCamA` matches; beware const-expression overflow (`0u − 1u` literal is a compile error).

**Crossfade** is two things: (1) LOD per-level fade `p.fade(level)` → a per-draw uniform; (2) `web/src/crossfade.ts`, the reduced-motion snapshot via `drawImage` of the tree canvas in the same task it was drawn. WebGPU canvases are readable until presented; W5 verifies.

**`syncGpu`/`bench` are synchronous** via `readPixels`. WebGPU only has async `queue.onSubmittedWorkDone()` → `bench` becomes async (Playwright `page.evaluate` awaits).

**Canvas context lock-in**: after `getContext('webgpu')` a canvas can never give `webgl2`. Backend selection (adapter + device) must finish before any `getContext`; mid-session fallback = reload with `?renderer=webgl`.

## 1. Renderer interface

New `web/src/render/types.ts`; `FrameParams`, `Dim`, `Highlight`, `PathDraw`, `RingDraw`, `FrameStats`, `NO_HIGHLIGHT` move here from `gl/renderer.ts` unchanged.

```ts
export type BackendKind = 'webgpu' | 'webgl2';

/** Backend-owned GPU copy of one tile; backends narrow it with instanceof. */
export interface GpuTile { readonly level: number; readonly count: number; readonly internalCount: number; }

/** Top-down RGBA8 pixels of the tree canvas (precision test, parity). */
export interface Pixels { width: number; height: number; data: Uint8Array; }

export interface Renderer {
  readonly kind: BackendKind;
  upload(tile: Tile): GpuTile;
  release(tile: GpuTile): void;
  setFans(data: Uint32Array): void;
  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats;
  /** Drawing-buffer size in device px. */
  size(): { width: number; height: number };
  /** Resolves when the GPU has finished all submitted work. */
  finish(): Promise<void>;
  /** The frame just drawn. Call in the same task as draw(). */
  readPixels(): Promise<Pixels>;
  /** Last GPU frame time in ms when timestamp-query is available, else null. */
  gpuMs(): number | null;
  /** Fired when the GPU was lost and the backend could not recover. */
  onLost: (reason: string) => void;
  destroy(): void;
}
```

**Selection** (`web/src/render/select.ts`)
```ts
export function backendOrder(q: URLSearchParams, env: { hasGpu: boolean; webgpuFailedBefore: boolean }): BackendKind[];
export async function createRenderer(canvas: HTMLCanvasElement, palette: RunPalette, order: readonly BackendKind[],
  factories: Record<BackendKind, (c: HTMLCanvasElement, p: RunPalette, opts: { allowFallbackAdapter: boolean }) => Promise<Renderer | null>>,
): Promise<Renderer | null>;
```
- default → `['webgpu','webgl2']`; `?renderer=webgl` → `['webgl2']`; `?renderer=webgpu` → `['webgpu','webgl2']` with `allowFallbackAdapter: true` and `console.warn` on fallback; `?nowebgl` → `[]` (fallback page, unchanged flag); `sessionStorage` memo of an earlier loss or no `navigator.gpu` → skip webgpu.
- Software adapters (`adapter.info.isFallbackAdapter`) are rejected unless the URL forces webgpu.
- Factories load via dynamic `import()` so only one backend ships per visit; initial JS stays ~43 KB gz.
- `window.__renderer = kind` is always set; harnesses assert it.

**File changes**
- `scene.ts`: `constructor(renderer, canvas, meta, palette)`; `waitForGpu` → `await renderer.finish()`; `bench(n): Promise<number>`; no `gl`.
- `main.ts`: fetch meta and the adapter in parallel, build `RunPalette`, `createRenderer`, else `mountFallback`; `__bench` async.
- `debug.ts`: `runPrecisionTest(scene, renderer)` via `readPixels` (top-down); comparison moves to pure `compareFrames` in `render/pixels.ts`.
- `gl/renderer.ts` → `class WebGl2Renderer implements Renderer`, executing the shared plan (§2.1).
- `gl/context.ts` keeps GL helpers; `backingStoreSize`, `treeDpr`, `fitCanvas` move to `render/canvas.ts` (`context.test.ts` → `render/canvas.test.ts`).
- `selection.ts`, `hover.ts`: import paths only.
- `tiles/cache.ts`: add `rebuild()` (re-upload every resident tile from its CPU `Tile`; used after device loss).

## 2. WebGL2 → WebGPU mapping

### 2.1 Shared frame plan (main parity lever)
Move all per-draw CPU logic out of `Renderer.draw` into a pure `planFrame(tiles, fans: { count; spans: Float64Array }, p: FrameParams, size): DrawCmd[]` in `web/src/render/plan.ts`. `DrawCmd` is a discriminated union by `pass` (vertex count, instance range/`firstInstance`, tile, typed params, blend id). Absorbs `S.frameLook`, the fan split, fade skips, K choice, `tipCut`, `leaderAlpha`, the treeDim rect, path/ring skips, stats counting. Both backends just execute commands. Debug filter `?passes=branches,arcs` applies to the plan in both backends.

### 2.2 Shaders and pipelines
WGSL has no `#include`; modules are concatenated in TS: `structs (generated) + common.wgsl + palette.wgsl + frag.wgsl + tile.wgsl + body`, in `web/src/gpu/shaders/`, imported with `?raw`.

| GLSL | WGSL module | Pipeline (topology, blend) | Bind groups |
|---|---|---|---|
| common.glsl | `common.wgsl`: `polarToClipOffset`, `sinPrecise`, `clampedPoint` (struct), `childFade`, `isHome*`, `ss()` | – | – |
| palette.glsl | `palette.wgsl`: `kingdomColour`, `runLen` | – | – |
| frag.glsl | `frag.wgsl`: `revealMask`, `tint`, `bandPos`, `rimBoost`, `extRamp`, `hash`, `strands` | – | – |
| (new) | `tile.wgsl`: `tileAngle(i)`, `tileR(i)`, `tileU8(field,i)`… | – | g2 |
| branches.vert + line.frag | `lines.wgsl`: `vs_branches`, `fs_line` | line-list, saturating | g0, g1, g2 = tile |
| arcs.vert + line.frag | `lines.wgsl`: `vs_arcs`, `fs_line` | line-list, saturating | g0, g1, g2 = tile |
| fans | `fans.wgsl` | triangle-list, saturating; `draw(6K, n, 0, first)` (base instance) | g0, g1, g2 = fan storage (4 words) |
| rim | `rim.wgsl` | triangle-list, saturating | g0, g1 |
| marks | `marks.wgsl` | triangle-strip, `(one, one)` | g0, g1, g2 = tile |
| path | `path.wgsl` | triangle-list, `(one, one−src-alpha)` | g0, g1, g2 = path slot storage |
| ring | `ring.wgsl` | triangle-strip, `(one, one−src-alpha)` | g0, g1 |
| dim | `dim.wgsl` | triangle-list, `(zero, one−src-alpha)` colour and alpha | g0, g1 |

- Saturating = colour and alpha `src: one-minus-dst-alpha, dst: one`. Blend baked per pipeline.
- `createRenderPipelineAsync`, surfacing `getCompilationInfo()` messages. Two explicit pipeline layouts: `[frame, draw, data]` and `[frame, draw]` (rim, ring, dim).
- MSAA: `sampleCount: 4` colour texture in the canvas format, `resolveTarget = context.getCurrentTexture()`, `loadOp: 'clear'` (0,0,0,0), `storeOp: 'discard'`. Default interpolation.
- Plan B, only if line parity fails: 1 px quads with analytic coverage, reusing `path.wgsl` widening.

### 2.3 Uniforms and buffers
WGSL host-shareable layout: f32/u32/i32 align 4; vec2 align 8; vec3 align 16 size 12 (a scalar can pack after); vec4 align 16; struct size rounds to max align; uniform arrays need element stride 16.

`web/src/gpu/layout.ts`: `structLayout([['camA','u32'], …])` → offsets and size; `wgslStruct(name, layout)` **generates the WGSL struct text**, so TS is the single source of truth.

**g0 b0 `Frame`** (128 B, one `writeBuffer` per frame)

| Offset | Fields |
|---|---|
| 0 | camA u32, camFrac f32, camR vec2f (@8) |
| 16 | scale f32 |
| 24 | rotCS vec2f |
| 32 | half vec2f |
| 40 | rWin vec2f |
| 48 | winLo u32, winSpan u32 |
| 56 | seamUnits f32, lambdaExt f32 |
| 64 | homeId u32 (0xffffffff = none), homeAngle u32, reveal f32 (finite sentinel), revealSoft f32 |
| 80 | tintPow f32, rimBand f32, rimBoost f32, pxPerUnit f32 |
| 96 | branch vec3f, extInner f32 @108 |
| 112 | extPow f32, extFar f32, pad to 128 |

Camera hi/lo split exactly as `camera.uniforms()`; written through a `Float32Array` view (`Math.fround`-identical to `uniform2f`).

**g0 b1 `Palette`** (static): `count i32`, `start: array<vec4u, 8>` read as `start[k/4][k%4]`, `rgb0`/`rgb1: array<vec4f, 32>`.

**g1 `Draw`** (dynamic offset): one buffer of 256 B slots (`minUniformBufferOffsetAlignment`). Each `DrawCmd` writes its pass struct (≤ 64 B, e.g. `Marks{fade, px, spike: vec2, tipBar: vec3, tipHalo: vec2, leader: vec3}`) into slot i of a CPU `ArrayBuffer`; one `writeBuffer` per frame; `setBindGroup(1, drawBG, [i*256])`. Grows by doubling (bind group re-created).

**g2 data**
- Per tile: `GpuTile` holds `createBuffer({ size: nameOff, usage: STORAGE|COPY_DST })`, `writeBuffer(..., 0, nameOff)`, and its bind group. `release` → `buffer.destroy()` (safe: encoding is synchronous inside `draw`, the cache never evicts mid-encode).
- Fans and paths: growable storage buffers re-created on `setFans` / new path array (same identity check as `pathBuffer`).

**Canvas** (`web/src/gpu/target.ts`): `context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied', usage: RENDER_ATTACHMENT | COPY_SRC })`. Non-sRGB format matches GL linear writes. DPR, 6 Mpx cap, `fitCanvas` shared from `render/canvas.ts`. MSAA texture re-created on size change (checked at the start of `draw`).

**Readback** (`gpu/readback.ts`): `copyTextureToBuffer` from the current texture (`bytesPerRow` padded to 256), `mapAsync`; pure helper strips padding and swizzles BGRA→RGBA.

### 2.4 Device loss
- `device.lost` with reason ≠ `'destroyed'`: request a new adapter/device once, reconfigure, rebuild pipelines, `cache.rebuild()`, request a render.
- If that fails: set the `sessionStorage` memo and `location.replace` with `?renderer=webgl`, keeping `n` and `v` (avoids swapping the `#tree` canvas that `Input`/`Hover` hold).
- `device.onuncapturederror` increments `window.__gpuErrors`; harnesses assert 0.
- `?debug` exposes `window.__loseDevice`.

### 2.5 Compute shaders
Not in v1: fill-bound passes dominate; picking needs doubles and sync answers; `buildFans` runs rarely. Used as a **test tool** in W6: `?debug=parity` runs a compute shader evaluating `kingdomColour`, `polarToClipOffset`, `hash`, `strands`, `sinPrecise` on fixed inputs and compares with TS references. `timestamp-query` (when available) gives GPU frame time for the debug HUD and `__bench`.

## 3. Tests written first (vitest, no GPU unless noted)
1. `render/select.test.ts`: every URL/env combination; fallback-adapter policy; `requestAdapter` null and `requestDevice` throwing → webgl2; both fail → null (fallback page); loss memo skips webgpu. Fake factories typed, no `any`.
2. `render/plan.test.ts`: today's `draw` behaviour as examples: fan split and `fansWiderThan` boundaries; narrow `winSpan` → no wide draw; fade ≤ 0 skipped; arcs skipped when `internalCount` 0; K=128 for level ≤ 3; ring only when `look.ring > 0`; `tipCut` threshold; `leaderAlpha` clamp; treeDim drawn first; paths with n=0 or alpha ≤ 0 skipped; blend id per pass; `FrameStats` identical to today's counting; `passes` filter.
3. `gpu/layout.test.ts`: offsets for scalar/vec2/vec3(+scalar)/vec4, struct size rounding, uniform array stride 16 enforced, snapshot of `Frame` and generated WGSL text.
4. `gpu/uniforms.test.ts`: `packFrame` writes u32 as u32 (camA 0xffffffff, NO_HOME round-trip), f32 bit-equal to `Math.fround`; `reveal: Infinity` → sentinel; palette packing for counts 1, 12, 32; draw slots 256-aligned, growth.
5. `gpu/tiles.test.ts`: `tileWords(n)` indices equal `tileOffsets(n)` for n = 1, 2, 3, 4, 57 (golden), 1000; JS mirror of `tileU8`/`tileF32` reads `tiles/testTile.ts` correctly.
6. `gpu/shaders.test.ts`: WGSL `MAX_RUNS` equals `palette.ts`; lint: no `smoothstep(` with reversed literal edges; every `?raw` module concatenates; every entry point named in `pipelines.ts` exists.
7. `render/pixels.test.ts`: `flipRows`, `bgraToRgba`, `stripRowPadding`; `compareFrames` (synthetic diagonal shifted by (37,23) → max 0; moved 2 px → detected).
8. `tiles/cache.test.ts`: `rebuild()` re-uploads every resident once and releases old handles.
9. `scripts/pixeldiff.test.ts`: `diffImages(a, b, w, h, tol)` → `{ over, overPct, meanAbs, maxAbs }` + heatmap.
10. Browser level (Playwright): smoke/shot additions (W2, W5), precision on WebGPU, `?debug=parity` (W6).

## 4. Phases (one agent each, strictly in order)

**W0 Spike and baselines** (docs and scripts only)
- Add `@webgpu/types` (devDependency, `tsconfig` `types`); check TS 7 compatibility.
- Probe headless WebGPU with a throwaway Playwright script (Playwright 1.64.1 = Chromium 156.0.8078.4; `chromium-1248` and `chromium_headless_shell-1248` ship `libvk_swiftshader.so`): (a) headless shell vs `channel: 'chromium'`; (b) `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader` + `forceFallbackAdapter: true`; (c) real GPU `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist`; (d) note what desktop Chrome would report (`chrome://gpu`) if determinable without the user's browser. Record adapter availability, info, overview frame time.
- WebGL baselines into `screens/baseline-webgl/`: DEFAULTS + hidpi-overview + mobile-overview + reduced + hover-path + panel-homo + mid-l6.5-protists + deep-archaea. Noise floor: same state twice, SwiftShader and GPU.
- `docs/webgpu.md`: flag matrix and chosen flags.
- Accept: `make check` green; docs list working flags or an explicit "no headless WebGPU".

**W1 Tests as spec**: all of §3 items 1–9 plus stub modules with final signatures throwing `not implemented` (tsc green). Vitest red only in new files. No product behaviour change. Supervisor reviews.

**W2 Interface extraction and harness (WebGL only)**: implement `render/{types,plan,canvas,pixels,select}.ts` (webgl2 factory only); `WebGl2Renderer` executes the plan; `scene.ts`/`main.ts`/`debug.ts` per §1; async `bench`; `window.__renderer`. `scripts/pixeldiff.ts` (PNG decode in a Playwright page via `<img>` → canvas → `getImageData`, no new deps). `shot.ts`: `SHOT_RENDERER=webgl|webgpu|both` → `screens/<renderer>/<state>.png`; `both` or `SHOT_COMPARE=<dir>` → `screens/diff/<state>.png` + `report.json`, table, exit 1 over threshold; asserts `__renderer`. Makefile `shot-parity`. Accept: vitest green; diff vs W0 baseline at noise floor (SwiftShader and `SHOT_GPU=1`); precision unchanged (≤ 0.215 px, same unmatched); `make smoke` green; bundle within 1 KB gz; `gl/` is the only GL-aware code.

**W3 WebGPU core, lines only**: `gpu/{device,target,layout,uniforms,tiles,pipelines,renderer,readback}.ts`, `shaders/{common,palette,frag,tile,lines}.wgsl`. Branches and arcs complete, other passes no-ops. Factory registered, reachable only via `?renderer=webgpu`. Each new GPU module gets a header comment explaining its WebGPU concepts for the learner (adapter/device, canvas context, pipelines/layouts, bind groups and dynamic offsets, storage-buffer vertex pulling, command encoder, render pass and MSAA resolve, WGSL). Accept: zero `__gpuErrors`; `?passes=branches,arcs` WebGPU vs WebGL under threshold on overview, mammals, deep-homo; W1 layout/uniforms/tiles tests green.

**W4 All passes**: `fans, rim, marks, path, ring, dim` WGSL + blend table. Accept: all baseline states under threshold at DPR 1 and 2; `?debug=precision` on WebGPU max ≤ 0.25 px (target 0.215), unmatched no worse than WebGL (`SHOT_GPU=1`, and SwiftShader WebGPU if available); per-pass diffs for any failing state.

**W5 Robustness and default**: device loss (recreate → `cache.rebuild()` → else reload with memo; `__loseDevice`), fallback-adapter policy, dynamic-import splitting, reduced-motion crossfade not black on WebGPU, webgpu first by default. `smoke.ts` three runs: `?renderer=webgl`; `?renderer=webgpu` (required with `SMOKE_WEBGPU=1`, else skipped with a log line if `__renderer !== 'webgpu'`); `?nowebgl`. Accept: smoke green; forced loss recovers with no errors; `?renderer=webgpu` without WebGPU lands on WebGL2; initial JS ≤ ~45 KB gz.

**W6 Perf, instrumentation, docs**: `timestamp-query` GPU timing in debug HUD and `__bench`; `?debug=parity` compute page; `SHOT_GPU=1` WebGPU frame ≤ WebGL per state and ≤ 8 ms on the AMD iGPU; update PLAN §7 as-built, CLAUDE.md, `docs/webgpu.md` (mapping table). Accept: perf table in docs, `make check` green, parity page green.

W3/W4 touch only `web/src/gpu/` plus a one-line factory registration in `select.ts`.

## 5. Parity thresholds and headless strategy
- Per state: % of pixels whose max channel diff > `tol`, plus mean absolute error. Start `tol = 16`, `overPct ≤ 0.5%`, `meanAbs ≤ 1.0`; calibrate against the W0/W2 noise floor. Line AA (ANGLE GL lines vs Dawn `line-list`) is the expected main difference; W3 measures it alone.
- Headless WebGPU available (likely SwiftShader Vulkan, maybe `channel: 'chromium'`): everything runs headless; keep `__bench` at 3 frames.
- Not available: parity, precision, perf run locally with `SHOT_GPU=1`; headless still covers WebGL, the `?renderer=webgpu` → webgl2 fallback assertion, all vitest incl. WGSL static checks; the webgpu smoke run is skipped with an explicit log line.

## 6. Browser matrix (verify in W0/W6)

| Environment | Renderer |
|---|---|
| Chrome/Edge 113+ Windows, macOS, ChromeOS | WebGPU |
| Chrome Android 121+ (Android 12+) | WebGPU |
| Chrome Linux (Vulkan, per-GPU rollout) | WebGPU where enabled, else WebGL2 |
| Safari 26 macOS/iOS | WebGPU |
| Safari 15–18 | WebGL2 |
| Firefox 141+ Windows; newer macOS ARM | WebGPU |
| Firefox Linux/Android | WebGL2 |
| Software adapter only | WebGL2 unless `?renderer=webgpu` |
| Device lost, unrecoverable | reload into WebGL2 (session memo) |
| No WebGL2 | fallback page |

## 7. Risks
1. Hairline rasterisation differs → per-pass diff; quad-lines plan B.
2. f32 precision (contraction/reassociation), WGSL `sin` ~2⁻¹¹ abs accuracy → keep `sinPrecise` and hi/lo split; precision test + W6 compute parity.
3. Inf/NaN, reversed `smoothstep` → CPU sentinel, `ss()`, lint tests.
4. Headless WebGPU unavailable/slow → §5.
5. Canvas context lock-in → select before `getContext`; mid-session fallback is a reload.
6. `drawImage` from a WebGPU canvas → verify in W5; fallback copies via `readPixels`.
7. 4× MSAA at the 6 Mpx cap ≈ 96 MB, explicit, re-created on resize.
8. WGSL portability (Safari, Firefox) → manual check.
9. TS 7 + `@webgpu/types` → check in W0.

## 8. Decisions (supervisor defaults; the user may override)
1. Fallback page text: keep the current text (DESIGN.md §7, asserted by smoke) except it should no longer say only "WebGL2"; W5 may reword it to "GPU drawing unavailable" style copy following DESIGN.md.
2. Software WebGPU adapter by default: no.
3. Device loss: recreate once, then reload into WebGL2.
4. Small hairline AA differences under threshold are acceptable.
5. WebGL context-loss handling: out of scope for now.
6. `?renderer=none`: no.
7. GPU timestamps in the debug HUD: yes (W6).
