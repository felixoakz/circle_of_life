// Arcs joining a node's children: K chords along the arc at radius r, from
// arc_lo to arc_hi, clamped to the visible window (see clampedPoint in
// common.glsl). With uHalfW = 0, 2K vertices per internal node (LINES);
// otherwise 6K (TRIANGLES): each chord a quad widened in screen px, the
// arc's two ends run on by half a width so its corners with the children's
// branches close (branches.vert).
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
uniform float uHalfW; // 0: hairlines; else half the line width, device px

out float vR;
out vec3 vHue;
out float vAlpha;
out float vExtT;
out float vHome;
out float vAcross;

void main() {
  bool wide = uHalfW > 0.0;
  uint span = aArcHi - aArcLo;
  int seg = wide ? gl_VertexID / 6 : gl_VertexID / 2;
  int corner = gl_VertexID % 6;
  int end = wide ? ((corner == 1 || corner == 4 || corner == 5) ? 1 : 0) : gl_VertexID % 2;
  float side = (corner == 2 || corner == 3 || corner == 5) ? 1.0 : -1.0;
  uint a;
  bool visible = clampedPoint(aArcLo, span, seg, seg + end, uK, a);
  float alpha = uFade * childFade(aChildLevel, uLambdaExt);
  bool home = (aFlags & 8u) != 0u;
  vR = aR;
  vHue = kingdomColour(a);
  vAlpha = alpha * (home ? uHomeAlpha : uAlpha);
  vExtT = 1.0;
  vHome = home ? 1.0 : 0.0;
  vAcross = 0.0;
  if (!visible || span == 0u || aR < uRWin.x || aR > uRWin.y || alpha <= 0.0) {
    gl_Position = OFF_SCREEN;
    vAlpha = 0.0;
    return;
  }
  if (!wide) {
    gl_Position = polarToClip(a, aR);
    return;
  }
  uint a0;
  uint a1;
  bool ok0 = clampedPoint(aArcLo, span, seg, seg, uK, a0);
  bool ok1 = clampedPoint(aArcLo, span, seg, seg + 1, uK, a1);
  vec2 p0 = polarToClip(a0, aR).xy * uHalf;
  vec2 p1 = polarToClip(a1, aR).xy * uHalf;
  vec2 d = p1 - p0;
  float len = length(d);
  if (!ok0 || !ok1 || len < 1e-3) {
    gl_Position = OFF_SCREEN;
    vAlpha = 0.0;
    return;
  }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = uHalfW + 1.0;
  vec2 p = end == 0 ? p0 : p1;
  // The arc's own ends (not the joints between its chords) run on.
  if (end == 0 && seg == 0) p -= dir * uHalfW;
  if (end == 1 && seg == uK - 1) p += dir * uHalfW;
  p += nrm * side * w;
  vAcross = side * w;
  gl_Position = vec4(p / uHalf, 0.0, 1.0);
}
