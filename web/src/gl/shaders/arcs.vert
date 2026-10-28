// Arcs joining a node's children: 2K vertices per internal node (LINES),
// K chords along the arc at radius r, from arc_lo to arc_hi, clamped to the
// visible window (see clampedPoint in common.glsl).
layout(location = 1) in uint aArcLo;
layout(location = 2) in uint aArcHi;
layout(location = 3) in float aR;
layout(location = 5) in uint aChildLevel;
layout(location = 6) in uint aFlags;

uniform float uFade;
uniform float uLambdaExt;
uniform float uAlpha;
uniform float uHomeAlpha;
uniform int uK; // chords per arc

out float vR;
out vec3 vHue;
out float vAlpha;
out float vExtT;
out float vHome;

void main() {
  uint span = aArcHi - aArcLo;
  int seg = gl_VertexID / 2;
  uint a;
  bool visible = clampedPoint(aArcLo, span, seg, seg + gl_VertexID % 2, uK, a);
  float alpha = uFade * childFade(aChildLevel, uLambdaExt);
  bool home = (aFlags & 8u) != 0u;
  vR = aR;
  vHue = kingdomColour(a);
  vAlpha = alpha * (home ? uHomeAlpha : uAlpha);
  vExtT = 1.0;
  vHome = home ? 1.0 : 0.0;
  if (!visible || span == 0u || aR < uRWin.x || aR > uRWin.y || alpha <= 0.0) {
    gl_Position = OFF_SCREEN;
    vAlpha = 0.0;
  } else {
    gl_Position = polarToClip(a, aR);
  }
}
