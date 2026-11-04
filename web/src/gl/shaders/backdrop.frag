// The backdrop (DESIGN.md §5.1): a polar graticule in the wheel's own frame
// over a soft wash of the kingdom hues, beyond the rim. Everything is
// computed per pixel from the camera, so it turns and scales with the wheel
// at any zoom. Saturating blend after the tree: it fills only the light the
// tree left, so it stays behind the branches.
//
// The hue comes from backdrop.vert, per vertex of a coarse grid: it is
// blurred over hundreds of px, and reading the palette's uniform arrays
// for every pixel is what made this pass slow.
//
// Precision: at deep zoom the centre is ~10^7 px away, so nothing here
// subtracts two large numbers. The pixel is taken into the camera's local
// frame (x outward at the camera angle, device px); its distance from the
// rim is (ρ² − R²)/(ρ + R) plus the rim's exact offset from the camera
// point, and spoke phases come from u32 shifts of the camera angle.

uniform uint uCamA;
uniform float uCamFrac;
uniform vec2 uRotCS;
uniform vec2 uHalf;

uniform float uStrength;
uniform float uCamRPx;  // R·scale
uniform float uRimOff;  // (R − 1)·scale
uniform vec4 uGrid;     // line alpha, line px, spoke spacing px, ring spacing px
uniform float uRingFade;
uniform vec2 uFade;     // gap px, ramp px
uniform vec4 uWash;     // alpha, decay px, blur px, tint
uniform vec2 uCorona;   // how much the wash gathers into streamers (0..1), streamer cell px

in vec3 vHue;
out vec4 outColour;

const float TAU = 6.283185307179586;
const float TWO_32 = 4294967296.0;
const float RAD_PER_UNIT_F = 1.4629180792671596e-9;

// Coverage of a hairline `w` px wide at `dist` px from its centre.
float hairline(float dist, float w) {
  return clamp(0.5 * w + 0.5 - dist, 0.0, 1.0);
}

// Distance (px) to the nearest of 2^k spokes, at radius rho px. The phase
// of spoke 0 is the camera angle times 2^k, exact as u32 arithmetic.
float spokeDist(int k, float phi, float rho) {
  float n = exp2(float(k));
  float u = float(uCamA << uint(k)) / TWO_32 + uCamFrac * n / TWO_32 + phi * n / TAU;
  float f = fract(u);
  return min(f, 1.0 - f) * TAU * rho / n;
}

// Brightness of the soft streamers at world angle `a` (u32 units): value
// noise over 2^k angular cells, hashed per cell, so the streamers stay fixed
// to the world while it turns.
float streamer(uint a, int k) {
  uint i = a >> uint(32 - k);
  // The position within the cell is the bits below it, moved to the top.
  float f = float(a << uint(k)) / TWO_32;
  uint mask = (1u << uint(k)) - 1u;
  float h0 = hash(i ^ (uint(k) << 27));
  float h1 = hash(((i + 1u) & mask) ^ (uint(k) << 27));
  float h = mix(h0, h1, smoothstep(0.0, 1.0, f));
  return h * h;
}

void main() {
  // Screen offset from the centre, y up, into the camera's local frame.
  vec2 s = gl_FragCoord.xy - uHalf;
  vec2 l = vec2(s.x * uRotCS.x + s.y * uRotCS.y, -s.x * uRotCS.y + s.y * uRotCS.x);
  float ax = uCamRPx + l.x;
  float rho = length(vec2(ax, l.y));
  float d = (2.0 * uCamRPx * l.x + dot(l, l)) / max(rho + uCamRPx, 1e-6) + uRimOff;
  float fade = uStrength * smoothstep(uFade.x, uFade.x + uFade.y, d);
  if (fade <= 0.0) {
    outColour = vec4(0.0);
    return;
  }
  float phi = atan(l.y, ax);

  // Spokes: 2^k of them, k chosen per pixel so they stay uGrid.z..2·uGrid.z
  // apart; the next level's fade in over the octave as the radius grows.
  float lv = log2(TAU * rho / uGrid.z);
  int k = int(clamp(floor(lv), 2.0, 30.0));
  float kf = clamp(lv - float(k), 0.0, 1.0);
  float spokes = max(hairline(spokeDist(k, phi, rho), uGrid.y), kf * hairline(spokeDist(k + 1, phi, rho), uGrid.y));
  // Rings, from the rim outward.
  float v = d / uGrid.w;
  float v1 = 2.0 * v;
  float rings = max(hairline(abs(v - floor(v + 0.5)) * uGrid.w, uGrid.y),
                    uRingFade * hairline(abs(v1 - floor(v1 + 0.5)) * 0.5 * uGrid.w, uGrid.y));

  vec3 hue = vHue;
  float gridA = uGrid.x * max(spokes, rings);
  float washA = uWash.x * exp(-max(d, 0.0) / uWash.y);
  if (uCorona.x > 0.0) {
    // The pixel's world angle, u32 units (the offset is small next to a cell).
    float du = phi / RAD_PER_UNIT_F;
    uint a = du < 0.0 ? uCamA - uint(-du) : uCamA + uint(du);
    float lc = log2(TAU * rho / uCorona.y);
    int kc = int(clamp(floor(lc), 2.0, 29.0));
    float kcf = clamp(lc - float(kc), 0.0, 1.0);
    float st = mix(streamer(a, kc), streamer(a, kc + 1), kcf);
    washA *= mix(1.0, 2.2 * st, uCorona.x);
  }
  vec3 c = mix(uBranch, hue, uWash.w) * gridA + hue * washA;
  float a = min(gridA + washA, 1.0);
  outColour = vec4(c, a) * fade;
}
