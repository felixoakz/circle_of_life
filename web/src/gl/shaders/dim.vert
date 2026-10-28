// Darkened plates behind the HUD (and later the panel and search): one
// quad per rectangle, grown by the soft edge. dim.frag fades it out.
precision highp float;

uniform vec4 uRect;   // x0, y0, x1, y1 in device px, y down
uniform float uSoft;  // soft edge, device px
uniform vec2 uViewport;

const vec2 CORNER[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(1, 0), vec2(1, 1), vec2(0, 1));

void main() {
  vec2 c = CORNER[gl_VertexID];
  vec2 lo = uRect.xy - uSoft;
  vec2 hi = uRect.zw + uSoft;
  vec2 p = mix(lo, hi, c);
  gl_Position = vec4(p.x / uViewport.x * 2.0 - 1.0, 1.0 - p.y / uViewport.y * 2.0, 0.0, 1.0);
}
