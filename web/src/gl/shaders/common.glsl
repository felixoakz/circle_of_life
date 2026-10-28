// Shared by every tree vertex shader: the camera-relative polar transform
// (PLAN §7.2). Prepended after the #version line by gl/renderer.ts.
precision highp float;
precision highp int;

uniform uint uCamA;     // camera angle, u32 fixed point (integer part)
uniform float uCamFrac; // camera angle, fractional u32 units in [0, 1)
uniform vec2 uCamR;     // camera radius as float32 hi + lo
uniform float uScale;   // device px per world unit
uniform vec2 uRotCS;    // cos, sin of the screen angle of the local radial axis
uniform vec2 uHalf;     // half the viewport, device px
uniform vec2 uRWin;     // radii outside this window are off screen

const float RAD_PER_UNIT = 1.4629180792671596e-9; // 2π / 2^32

// sin() that keeps full relative precision for tiny angles. GPU sin() is
// often only accurate to ~1e-6 absolute; at max zoom 1e-6 rad is ~18 px, so
// small angles (the only ones visible at deep zoom) use a Taylor series.
float sinPrecise(float x) {
  if (abs(x) < 0.1) {
    float x2 = x * x;
    return x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0)));
  }
  return sin(x);
}

// Clip-space position of the world point at polar (a, r): polarToClip.
//
// Why not just send x = r·cos θ, y = r·sin θ as floats? A float32 has 24
// bits of mantissa: near r = 1 that is ~6e-8 world units, and at max zoom
// (~18M px per unit) that is a pixel or more — the picture would jitter.
// Instead everything is computed *relative to the camera*, in steps that
// never subtract two large, nearly equal floats:
//  1. a − uCamA is exact u32 arithmetic (it wraps correctly through 0); for
//     anything near the camera the signed difference is small and converts
//     to float without loss.
//  2. The local frame has x pointing outward at the camera angle. The point
//     is at x = r·cos Δθ − R, y = r·sin Δθ. Computing r·cos Δθ − R directly
//     cancels catastrophically (both ≈ 1), so use the identity
//     cos Δθ = 1 − 2·sin²(Δθ/2):  x = (r − R) − 2r·sin²(Δθ/2).
//  3. r − R is computed as (r − R_hi) − R_lo: r and R_hi are both float32
//     and close, so r − R_hi is exact; R_lo restores the bits of the
//     double-precision camera radius that R_hi could not hold.
//
// polarToClipOffset also moves the point by `off` device px: off.x outward
// along the radius at angle a, off.y along the tangent (counter-clockwise).
// The offset is added in the camera-relative frame, so it is exact at any
// zoom; rim marks use it for their pixel-sized quads.
vec4 polarToClipOffset(uint a, float r, vec2 off) {
  uint d = a - uCamA;
  // Signed difference without relying on int(uint) for values ≥ 2^31.
  float units = d >= 0x80000000u ? -float(0u - d) : float(d);
  float dth = (units - uCamFrac) * RAD_PER_UNIT;
  float s = sinPrecise(0.5 * dth);
  float sn = sinPrecise(dth);
  float cs = 1.0 - 2.0 * s * s;
  float x = ((r - uCamR.x) - uCamR.y) - 2.0 * r * s * s + (off.x * cs - off.y * sn) / uScale;
  float y = r * sn + (off.x * sn + off.y * cs) / uScale;
  vec2 p = vec2(x * uRotCS.x - y * uRotCS.y, x * uRotCS.y + y * uRotCS.x) * uScale;
  return vec4(p / uHalf, 0.0, 1.0);
}

vec4 polarToClip(uint a, float r) {
  return polarToClipOffset(a, r, vec2(0.0));
}

uniform uint uHomeId;    // pre-order id of the home node (Homo sapiens), or 0xffffffff
uniform uint uHomeAngle; // its angle

// Homo sapiens' subspecies are drawn as one row with it, at its angle
// (1.png: one white bar on the label's row), not half a tip either side.
bool isHomeChildTip(uint childLevel, uint parent) {
  return childLevel == 255u && parent == uHomeId;
}

// The home node and its children (Homo sapiens' two subspecies) are white.
bool isHome(uint flags, uint parent) {
  return (flags & 8u) != 0u || parent == uHomeId;
}

// Fade of a node's children: they are drawn from level `cl` on.
float childFade(uint cl, float lambdaExt) {
  if (cl == 255u) return 0.0; // a tip has no children
  if (cl == 0u) return 1.0;
  float c = float(cl);
  return smoothstep(c, c + 0.6, lambdaExt);
}

// An off-screen position for vertices that should draw nothing.
const vec4 OFF_SCREEN = vec4(4.0, 4.0, 0.0, 1.0);

uniform uint uWinLo;   // visible angular window start, u32 units
uniform uint uWinSpan; // its length; ≥ 2^30 means "do not clamp"

// Point j (0..K) of an angular range [lo, lo + span] cut into K steps, after
// clamping the range to the visible window. Clamping keeps the steps short
// where the range is on screen (a level-0 arc cut into K chords over the
// whole circle would be badly faceted at deep zoom). It is u32 arithmetic in
// the range's own parameter u ∈ [0, span], which never overflows. The window
// can cut the range in two (when the range's gap is on screen); then each
// piece gets half of the steps, chosen by `seg` (the step index).
// Returns false when nothing of the range is visible.
bool clampedPoint(uint lo, uint span, int seg, int j, int K, out uint a) {
  uint loA = 0u, hiA = span, loB = 0u, hiB = 0u;
  bool hasA = true, hasB = false;
  if (uWinSpan < 0x40000000u) {
    uint ws = uWinLo - lo; // window start in range parameter space (wraps)
    hasA = ws <= span;
    if (hasA) {
      loA = ws;
      hiA = (span - ws < uWinSpan) ? span : ws + uWinSpan;
    }
    uint toWrap = 0u - ws; // how far the window runs before wrapping to u = 0
    hasB = ws != 0u && toWrap <= uWinSpan;
    if (hasB) hiB = min(uWinSpan - toWrap, span);
    if (!hasA && hasB) {
      loA = loB; hiA = hiB; hasA = true; hasB = false;
    }
  }
  a = lo;
  if (!hasA) return false;
  int n = K;
  uint pLo = loA, pHi = hiA;
  if (hasB) {
    int h = K / 2;
    if (seg < h) {
      n = h;
    } else {
      pLo = loB; pHi = hiB; n = K - h; j -= h;
    }
  }
  // The last point is exact, so arcs meet their children's branches.
  uint u = j >= n ? pHi : pLo + uint(float(pHi - pLo) * (float(j) / float(n)));
  a = lo + u;
  return true;
}
