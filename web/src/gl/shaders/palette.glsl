// Kingdom colour at an angle: the group runs from meta (palette.ts
// RunPalette.colourAt is the same function on the CPU). Each run maps its
// span to its group's ramp; neighbouring runs meet in a seam uSeamUnits
// wide, at most a quarter of the shorter run, so even Archaea (0.09% of the
// circle) keeps its colour and a seam never shows a third kingdom's hue.
// Prepended to every vertex and fragment shader by gl/renderer.ts.
const int MAX_RUNS = 32;
uniform int uRunCount;
uniform uint uRunStart[MAX_RUNS]; // where each run starts, u32 units; the first is 0
uniform vec3 uRunRgb0[MAX_RUNS];  // sRGB at each run's start…
uniform vec3 uRunRgb1[MAX_RUNS];  // …and end
uniform float uSeamUnits;         // seam width at the rim, u32 units

// Length of run i (wrapping round), u32 units; the last run ends at 2^32.
float runLen(int i) {
  int k = (i + uRunCount) % uRunCount;
  uint next = k + 1 < uRunCount ? uRunStart[k + 1] : 0u;
  return float(next - uRunStart[k]);
}

vec3 kingdomColour(uint a) {
  int i = 0;
  for (int k = 1; k < MAX_RUNS; k++) {
    if (k >= uRunCount || a < uRunStart[k]) break;
    i = k;
  }
  float len = runLen(i);
  float d = float(a - uRunStart[i]);
  vec3 c = mix(uRunRgb0[i], uRunRgb1[i], d / len);
  if (uRunCount > 1) {
    float wLo = min(0.5 * uSeamUnits, 0.25 * min(len, runLen(i - 1)));
    float wHi = min(0.5 * uSeamUnits, 0.25 * min(len, runLen(i + 1)));
    float dHi = len - d;
    if (wLo > 0.0 && d < wLo) {
      c = mix(uRunRgb1[(i + uRunCount - 1) % uRunCount], c, 0.5 + 0.5 * d / wLo);
    } else if (wHi > 0.0 && dHi < wHi) {
      c = mix(uRunRgb0[(i + 1) % uRunCount], c, 0.5 + 0.5 * dHi / wHi);
    }
  }
  return c;
}
