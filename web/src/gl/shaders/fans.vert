// Frontier fans (see tiles/fans.ts): the undrawn children of a drawn node,
// drawn as a band from the node's radius to the rim that fans.frag breaks
// into fine strands. K steps along the angle, 6 vertices (two triangles)
// per step.
layout(location = 0) in uint aLo;
layout(location = 1) in uint aHi;
layout(location = 2) in float aR;
layout(location = 3) in uint aMeta; // level | 0x100 when fading out with level F

uniform float uLambda;
uniform float uFadeF; // fade-in of level F; "fading" fans fade out with it
uniform float uAlpha;
uniform int uK;

out float vR;
out vec3 vHue;
out float vAlpha;
out float vT;     // 0 at the node's radius, 1 at the rim
out float vUnits; // angle from the fan's start, u32 units

// Per corner of the two triangles: step offset (0 or 1) and inner/outer edge.
const int STEP[6] = int[6](0, 1, 0, 1, 1, 0);
const int OUTER[6] = int[6](0, 0, 1, 0, 1, 1);

void main() {
  int seg = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  uint a;
  bool visible = clampedPoint(aLo, aHi - aLo, seg, seg + STEP[corner], uK, a);

  float level = float(aMeta & 0xffu);
  float fade = level == 0.0 ? 1.0 : smoothstep(level, level + 0.6, uLambda);
  if ((aMeta & 0x100u) != 0u) fade *= 1.0 - uFadeF;

  float r = clamp(OUTER[corner] == 1 ? 1.0 : aR, uRWin.x, uRWin.y);
  vR = r;
  vHue = kingdomColour(a);
  vAlpha = fade * uAlpha;
  vT = clamp((r - aR) / max(1.0 - aR, 1e-6), 0.0, 1.0);
  vUnits = float(a - aLo);
  gl_Position = (visible && fade > 0.0 && aR < uRWin.y) ? polarToClip(a, r) : OFF_SCREEN;
}
