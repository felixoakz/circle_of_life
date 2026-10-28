// Multiplies what is drawn by 1 − amount inside the rectangle, easing to
// nothing over the soft edge (blendFunc ZERO, ONE_MINUS_SRC_ALPHA).
precision highp float;

uniform vec4 uRect;
uniform float uSoft;
uniform float uAmount;
uniform vec2 uViewport;
out vec4 outColour;

void main() {
  // gl_FragCoord is y up; the rectangle is y down.
  vec2 p = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y);
  vec2 d = max(max(uRect.xy - p, p - uRect.zw), 0.0);
  float a = uAmount * (1.0 - smoothstep(0.0, max(uSoft, 1e-3), length(d)));
  outColour = vec4(0.0, 0.0, 0.0, a);
}
