// The rim's analytic glow: a crisp core, a soft halo (tighter outside,
// wider inside, where the rim band is), and the "fur": short outward
// strokes of hashed length, one per fine column. Kingdom colour, additive.

uniform float uStrength; // glow for this zoom × the ring's fade-out
uniform vec2 uCore;      // amount, σ px
uniform vec4 uHalo;      // outside amount, outside decay px, inside amount, inside decay px
uniform vec3 uFur;       // amount, max length px, column px
uniform vec2 uReach;     // px drawn inside, outside the rim

in float vR;
in float vDelta;
in float vUnits;
out vec4 outColour;

float fur(float h, float d) {
  float len = uFur.y * (0.2 + 0.8 * h * h);
  float bright = 0.4 + 0.6 * fract(h * 61.0);
  return bright * (1.0 - smoothstep(0.0, len, d));
}

void main() {
  float d = vDelta;
  float core = uCore.x * exp(-(d * d) / (uCore.y * uCore.y));
  // The inner halo has its tail at the annulus edge subtracted (and is
  // rescaled), so it reaches exactly zero there: no straight-edged step
  // where the annulus ends, however coarse its chords.
  float tail = exp(-uReach.x / uHalo.w);
  float haloIn = uHalo.z * max(exp(d / uHalo.w) - tail, 0.0) / (1.0 - tail);
  float halo = d > 0.0 ? uHalo.x * exp(-d / uHalo.y) : haloIn;
  float f = 0.0;
  if (d > 0.0) {
    vec3 s = strands(vUnits, uFur.z);
    f = uFur.x * mix(fur(s.x, d), fur(s.y, d), s.z);
  }
  float a = uStrength * (core + halo + f) * revealMask(vR);
  // Per fragment: a chord of the ring is far longer than a sliver like Archaea.
  outColour = vec4(kingdomColour(uint(min(vUnits, 4294967040.0))) * a, a);
}
