// Shared by every tree pipeline: the frame and palette bindings, the
// camera-relative polar transform (PLAN §7.2) and small helpers. Port of
// gl/shaders/common.glsl.
//
// WGSL in one paragraph: `fn name(arg: type) -> type { … }`; `let` is an
// immutable value, `var` a mutable one; types are spelled out (f32, u32,
// i32, vec2f, vec4f, …) and never convert implicitly, so mixing u32 and f32
// needs `f32(x)` / `u32(x)`. There is no `#include`: gpu/pipelines.ts glues
// the generated structs (`Frame`, `Palette`, the per-draw structs from
// gpu/layout.ts) and these shared files in front of each pipeline's module.

// Group 0 is set once per frame: the camera and look (`Frame`) and the
// kingdom colours (`Palette`), both uniform buffers.
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> palette: Palette;

const RAD_PER_UNIT: f32 = 1.4629180792671596e-9; // 2π / 2^32

// smoothstep with edges in either order. WGSL leaves smoothstep(e0, e1, x)
// with e0 ≥ e1 undefined, and several looks here fade "backwards" (1 → 0).
fn ss(e0: f32, e1: f32, x: f32) -> f32 {
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// sin() that keeps full relative precision for tiny angles: GPU sin() is
// only accurate to ~1e-6 absolute, ~18 px at max zoom (see common.glsl).
fn sinPrecise(x: f32) -> f32 {
  if (abs(x) < 0.1) {
    let x2 = x * x;
    return x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0)));
  }
  return sin(x);
}

// Clip-space position of the world point at polar (a, r), moved by `off`
// device px (outward, tangential). Everything is relative to the camera so
// no step subtracts two large, nearly equal floats; common.glsl explains
// each step. Clip space is y-up in WebGPU as in WebGL, so this is unchanged.
fn polarToClipOffset(a: u32, r: f32, off: vec2f) -> vec4f {
  // u32 subtraction wraps, exactly like GLSL's uint.
  let d = a - frame.camA;
  var units: f32;
  if (d >= 0x80000000u) {
    units = -f32(0u - d);
  } else {
    units = f32(d);
  }
  let dth = (units - frame.camFrac) * RAD_PER_UNIT;
  let s = sinPrecise(0.5 * dth);
  let sn = sinPrecise(dth);
  let cs = 1.0 - 2.0 * s * s;
  let x = ((r - frame.camR.x) - frame.camR.y) - 2.0 * r * s * s + (off.x * cs - off.y * sn) / frame.scale;
  let y = r * sn + (off.x * sn + off.y * cs) / frame.scale;
  let rot = frame.rotCS;
  let p = vec2f(x * rot.x - y * rot.y, x * rot.y + y * rot.x) * frame.scale;
  return vec4f(p / frame.half, 0.0, 1.0);
}

fn polarToClip(a: u32, r: f32) -> vec4f {
  return polarToClipOffset(a, r, vec2f(0.0));
}

// Homo sapiens' subspecies are drawn as one row with it, at its angle.
fn isHomeChildTip(childLevel: u32, parent: u32) -> bool {
  return childLevel == 255u && parent == frame.homeId;
}

// The home node and its children are white.
fn isHome(flags: u32, parent: u32) -> bool {
  return (flags & 8u) != 0u || parent == frame.homeId;
}

// Fade of a node's children: they are drawn from level `cl` on.
fn childFade(cl: u32, lambdaExt: f32) -> f32 {
  if (cl == 255u) {
    return 0.0; // a tip has no children
  }
  if (cl == 0u) {
    return 1.0;
  }
  let c = f32(cl);
  return ss(c, c + 0.6, lambdaExt);
}

// An off-screen position for vertices that should draw nothing.
const OFF_SCREEN = vec4f(4.0, 4.0, 0.0, 1.0);

// Result of clampedPoint. GLSL returned a bool and wrote the angle through
// an `out` parameter; WGSL functions return one value, so it is a struct.
struct ArcPoint {
  ok: bool,
  a: u32,
}

// Point j (0..K) of the angular range [lo, lo + span] cut into K steps,
// after clamping the range to the visible window (common.glsl explains the
// two-piece case). `ok` is false when nothing of the range is visible.
fn clampedPoint(lo: u32, span: u32, seg: i32, jIn: i32, K: i32) -> ArcPoint {
  var loA = 0u;
  var hiA = span;
  var loB = 0u;
  var hiB = 0u;
  var hasA = true;
  var hasB = false;
  if (frame.winSpan < 0x40000000u) {
    let ws = frame.winLo - lo; // window start in range parameter space (wraps)
    hasA = ws <= span;
    if (hasA) {
      loA = ws;
      if (span - ws < frame.winSpan) {
        hiA = span;
      } else {
        hiA = ws + frame.winSpan;
      }
    }
    let toWrap = 0u - ws; // how far the window runs before wrapping to u = 0
    hasB = ws != 0u && toWrap <= frame.winSpan;
    if (hasB) {
      hiB = min(frame.winSpan - toWrap, span);
    }
    if (!hasA && hasB) {
      loA = loB;
      hiA = hiB;
      hasA = true;
      hasB = false;
    }
  }
  if (!hasA) {
    return ArcPoint(false, lo);
  }
  var j = jIn;
  var n = K;
  var pLo = loA;
  var pHi = hiA;
  if (hasB) {
    let h = K / 2;
    if (seg < h) {
      n = h;
    } else {
      pLo = loB;
      pHi = hiB;
      n = K - h;
      j -= h;
    }
  }
  // The last point is exact, so arcs meet their children's branches.
  var u = pHi;
  if (j < n) {
    u = pLo + u32(f32(pHi - pLo) * (f32(j) / f32(n)));
  }
  return ArcPoint(true, lo + u);
}
