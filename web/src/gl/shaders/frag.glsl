// Shared by every fragment shader: the intro reveal, the grey → kingdom
// tint of lines, and hashed strands. Prepended after the #version line by
// gl/renderer.ts. Output is premultiplied for additive blending (ONE, ONE)
// on the black canvas.
precision highp float;
precision highp int;

uniform float uReveal;     // intro: nothing beyond this radius is drawn yet
uniform float uRevealSoft; // width of the reveal front, world radius
uniform vec3 uBranch;      // --branch grey, sRGB
uniform float uTintPow;    // concentrates the kingdom colour near the rim
uniform float uRimBand;    // lines brighten from this radius (RIM_BAND_PX inside the rim)…
uniform float uRimBoost;   // …by up to this much more at the rim
uniform float uExtFar;     // extensions and fans far from the rim band dim to this
uniform float uPxPerUnit;  // device px per u32 angle unit at the rim

float revealMask(float r) {
  return 1.0 - smoothstep(uReveal - uRevealSoft, uReveal, r);
}

// Grey interior turning to the kingdom colour towards the rim (DESIGN.md §5).
vec3 tint(vec3 lut, float r) {
  return mix(uBranch, lut, pow(smoothstep(0.55, 1.0, r), uTintPow));
}

// Distance from the rim in band widths (0 at the rim, 1 at the band's inner edge).
float bandPos(float r) {
  return (1.0 - r) / (1.0 - uRimBand);
}

float rimBoost(float r) {
  return 1.0 + uRimBoost * smoothstep(1.0, 0.0, bandPos(r));
}

// Unresolved lineages (extensions, fans) build up towards the rim: along
// their own length (t: 0 at their node, 1 at the rim) and on screen, so a
// mid-zoom view of the rim zone is a glowing band rather than a uniform wall.
uniform float uExtInner;
uniform float uExtPow;
float extRamp(float t, float r) {
  return mix(uExtInner, 1.0, pow(t, uExtPow)) * mix(uExtFar, 1.0, smoothstep(3.0, 0.5, bandPos(r)));
}

// Integer hash (lowbias32) → [0, 1).
float hash(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return float(x) * (1.0 / 4294967296.0);
}

// Fine radial strands that stay attached to the world while zooming. The
// angle (`units`, u32 units from some fixed anchor) is cut into columns
// 2^k units wide, with k chosen so a column is about `px` device px on
// screen. A column's hash drives its strand. The two nearest octaves
// crossfade, so zooming never pops: returns (hash at octave k, hash at
// octave k + 1, weight of the second).
vec3 strands(float units, float px) {
  float k = log2(max(px / uPxPerUnit, 1.0));
  float k0 = floor(k);
  float w0 = exp2(k0);
  uint c0 = uint(floor(units / w0));
  uint c1 = uint(floor(units / (2.0 * w0)));
  return vec3(hash(c0 ^ (uint(k0) << 27)), hash(c1 ^ (uint(k0 + 1.0) << 27)), k - k0);
}
