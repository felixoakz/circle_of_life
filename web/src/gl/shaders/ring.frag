// A 1 px antialiased circle (the selection ring), opaque like path.frag.
precision highp float;

uniform vec4 uColour;
uniform float uRadius;
uniform float uLinePx;

in vec2 vOff;
out vec4 outColour;

void main() {
  float d = abs(length(vOff) - uRadius);
  float cov = clamp(0.5 * uLinePx + 0.5 - d, 0.0, 1.0);
  outColour = vec4(uColour.rgb * uColour.a * cov, cov);
}
