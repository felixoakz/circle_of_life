// Kingdom colour at an angle, from the group runs in `palette` (palette.ts
// RunPalette.colourAt is the same function on the CPU). Port of
// gl/shaders/palette.glsl; the seams are explained there.
//
// Uniform arrays need a 16-byte element stride, so the run starts are packed
// four to a vec4u (`start[k / 4][k % 4]`) and colours are vec4f with an
// unused w (gpu/uniforms.ts `packPalette`).

const MAX_RUNS: i32 = 32;

fn runStart(k: i32) -> u32 {
  return palette.start[k / 4][k % 4];
}

// Length of run i (wrapping round), u32 units; the last run ends at 2^32.
fn runLen(i: i32) -> f32 {
  let k = (i + palette.count) % palette.count;
  var next = 0u;
  if (k + 1 < palette.count) {
    next = runStart(k + 1);
  }
  return f32(next - runStart(k));
}

fn kingdomColour(a: u32) -> vec3f {
  var i = 0;
  for (var k = 1; k < MAX_RUNS; k++) {
    if (k >= palette.count || a < runStart(k)) {
      break;
    }
    i = k;
  }
  let count = palette.count;
  let len = runLen(i);
  let d = f32(a - runStart(i));
  var c = mix(palette.rgb0[i].xyz, palette.rgb1[i].xyz, d / len);
  if (count > 1) {
    let wLo = min(0.5 * frame.seamUnits, 0.25 * min(len, runLen(i - 1)));
    let wHi = min(0.5 * frame.seamUnits, 0.25 * min(len, runLen(i + 1)));
    let dHi = len - d;
    if (wLo > 0.0 && d < wLo) {
      c = mix(palette.rgb1[(i + count - 1) % count].xyz, c, 0.5 + 0.5 * d / wLo);
    } else if (wHi > 0.0 && dHi < wHi) {
      c = mix(palette.rgb0[(i + 1) % count].xyz, c, 0.5 + 0.5 * dHi / wHi);
    }
  }
  return c;
}
