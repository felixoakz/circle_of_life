// Branches and arcs (PLAN §7.3): grey hairlines taking the kingdom colour
// towards the rim. Frontier extensions start faint at their node and build
// up towards the rim, where their unresolved lineages would be.

in float vR;
in vec3 vHue;
in float vAlpha;
in float vExtT; // 0 at an extension's node, 1 at the rim; exactly 1 for ordinary lines
in float vHome;
out vec4 outColour;

void main() {
  float ext = vExtT < 1.0 ? extRamp(vExtT, vR) : 1.0;
  float a = vAlpha * ext * rimBoost(vR) * revealMask(vR);
  vec3 c = mix(tint(vHue, vR), vec3(1.0), vHome);
  outColour = vec4(c * a, a);
}
