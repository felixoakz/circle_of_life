// Shared fragment-side looks: the intro reveal, the grey → kingdom tint of
// lines, the rim band, extension ramps and hashed strands. Port of
// gl/shaders/frag.glsl. Output is premultiplied alpha.

// 1 inside the intro reveal, 0 beyond it. `frame.reveal` is a large finite
// number once the intro is done (gpu/uniforms.ts REVEAL_DONE): WGSL may
// assume floats are never infinite, and smoothstep(inf − s, inf, r) is NaN.
fn revealMask(r: f32) -> f32 {
  return 1.0 - ss(frame.reveal - frame.revealSoft, frame.reveal, r);
}

// Grey interior turning to the kingdom colour towards the rim (DESIGN.md §5).
fn tint(lut: vec3f, r: f32) -> vec3f {
  return mix(frame.branch, lut, pow(ss(0.55, 1.0, r), frame.tintPow));
}

// Distance from the rim in band widths (0 at the rim, 1 at the band's inner edge).
fn bandPos(r: f32) -> f32 {
  return (1.0 - r) / (1.0 - frame.rimBand);
}

fn rimBoost(r: f32) -> f32 {
  return 1.0 + frame.rimBoost * ss(1.0, 0.0, bandPos(r));
}

// Unresolved lineages (extensions, fans) build up towards the rim: along
// their own length (t: 0 at their node, 1 at the rim) and on screen.
fn extRamp(t: f32, r: f32) -> f32 {
  return mix(frame.extInner, 1.0, pow(t, frame.extPow)) * mix(frame.extFar, 1.0, ss(3.0, 0.5, bandPos(r)));
}

// Integer hash (lowbias32) → [0, 1). u32 multiplication wraps, as in GLSL.
fn hash(xIn: u32) -> f32 {
  var x = xIn;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return f32(x) * (1.0 / 4294967296.0);
}

// Fine radial strands that stay attached to the world while zooming
// (frag.glsl explains the octaves): returns (hash at octave k, hash at
// octave k + 1, weight of the second).
fn strands(units: f32, px: f32) -> vec3f {
  let k = log2(max(px / frame.pxPerUnit, 1.0));
  let k0 = floor(k);
  let w0 = exp2(k0);
  let c0 = u32(floor(units / w0));
  let c1 = u32(floor(units / (2.0 * w0)));
  return vec3f(hash(c0 ^ (u32(k0) << 27u)), hash(c1 ^ (u32(k0 + 1.0) << 27u)), k - k0);
}
