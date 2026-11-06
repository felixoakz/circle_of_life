// Highlighted paths (ARCHITECTURE §7.3 pass 5): the hover path and the selection
// path, root → node, as 2 px quads. One instance per segment (path.ts): an
// arc (span > 0, at radius r0) or a radial segment (span = 0, r0 → r1), cut
// into uK steps; each step is a quad of 6 vertices between two points that
// go through the precise camera-relative transform, widened in screen px.
layout(location = 0) in uint aA0;
layout(location = 1) in uint aSpan;
layout(location = 2) in float aR0;
layout(location = 3) in float aR1;

uniform int uK;
uniform float uHalfW; // half the line width, device px

out float vAcross; // px from the centre line

// Point j of this segment in device px from the screen centre; false when
// the arc's step is off screen.
bool pathPoint(int seg, int j, out vec2 p) {
  if (aSpan == 0u) {
    float r = clamp(mix(aR0, aR1, float(j) / float(uK)), uRWin.x, uRWin.y);
    p = polarToClip(aA0, r).xy * uHalf;
    return true;
  }
  uint a;
  bool ok = clampedPoint(aA0, aSpan, seg, j, uK, a);
  p = polarToClip(a, aR0).xy * uHalf;
  return ok;
}

void main() {
  int seg = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  // Two triangles: (0,−) (1,−) (0,+) / (0,+) (1,−) (1,+).
  int end = (corner == 1 || corner == 4 || corner == 5) ? 1 : 0;
  float side = (corner == 2 || corner == 3 || corner == 5) ? 1.0 : -1.0;
  vec2 p0, p1;
  bool ok = pathPoint(seg, seg, p0) && pathPoint(seg, seg + 1, p1);
  vec2 d = p1 - p0;
  float len = length(d);
  if (!ok || len < 1e-3 || aR1 < aR0) {
    gl_Position = OFF_SCREEN;
    vAcross = 0.0;
    return;
  }
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = uHalfW + 1.0; // room for antialiasing
  // Each step runs on by half a width at both ends, so joints and corners
  // close; the path is opaque (path.frag), so the overlaps do not show.
  vec2 p = (end == 0 ? p0 - dir * uHalfW : p1 + dir * uHalfW) + nrm * side * w;
  vAcross = side * w;
  gl_Position = vec4(p / uHalf, 0.0, 1.0);
}
