// A tip dot: a filled disc antialiased over one device px, opaque over its
// line (premultiplied, blended "over").
uniform float uRadius;

in vec2 vOff;
in vec3 vColour;
in float vAlpha;
out vec4 outColour;

void main() {
  float cov = clamp(uRadius + 0.5 - length(vOff), 0.0, 1.0);
  float a = vAlpha * cov * revealMask(1.0);
  outColour = vec4(vColour * a, a);
}
