// Frontier fans as bundles of fine lines rather than flat polygons. Each
// strand (one per ~FAN_LINE_PX column, hashed) stands for a lineage that
// branches off somewhere between the node and the rim, so the bundle is
// sparse near its node and dense near the rim, and takes the kingdom
// colour only there.

uniform float uLinePx; // strand width, device px

in float vR;
in vec3 vHue;
in float vAlpha;
in float vT;
in float vUnits;
out vec4 outColour;

// Strand with hash h at depth t: it starts at a hashed point along the fan
// (most start late) and has its own brightness.
float strand(float h, float t) {
  float start = 0.92 * (1.0 - h * h);
  float bright = 0.35 + 0.65 * fract(h * 97.0);
  return smoothstep(start, start + 0.08, t) * bright;
}

void main() {
  vec3 s = strands(vUnits, uLinePx);
  float k = mix(strand(s.x, vT), strand(s.y, vT), s.z);
  float a = vAlpha * k * extRamp(vT, vR) * rimBoost(vR) * revealMask(vR);
  outColour = vec4(tint(vHue, vR) * a, a);
}
