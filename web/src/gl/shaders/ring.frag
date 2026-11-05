// The selection marker: an antialiased ring and centre dot in uColour over
// a dark disc that clears the glow behind them, opaque like path.frag.
precision highp float;

uniform vec4 uColour;
uniform float uRadius;
uniform float uLinePx;
uniform float uDot;   // centre dot radius, px
uniform vec2 uKnock;  // px past the ring, opacity

in vec2 vOff;
out vec4 outColour;

void main() {
  float len = length(vOff);
  float ring = clamp(0.5 * uLinePx + 0.5 - abs(len - uRadius), 0.0, 1.0);
  float dot = clamp(uDot + 0.5 - len, 0.0, 1.0);
  float cov = max(ring, dot) * uColour.a;
  float knock = uKnock.y * uColour.a * clamp(uRadius + uKnock.x + 0.5 - len, 0.0, 1.0);
  // Premultiplied: the colour over the dark disc.
  outColour = vec4(uColour.rgb * cov, max(cov, knock));
}
