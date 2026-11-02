// Rim ring (PLAN §7.3 pass 3): an annulus around r = 1, from reach.x px
// inside to reach.y px outside, cut into K steps over the visible part of
// the circle; fs_rim shades it analytically (core, halo, fur). Port of
// rim.vert and rim.frag.
//
// This pipeline has no group 2 (its layout is [frame, draw]): the vertex
// shader makes every position from `vertex_index` alone, so there is no
// data to read. The module still contains tile.wgsl's `tile` declaration;
// that is fine, because a pipeline only needs bindings its entry points
// actually use.

@group(1) @binding(0) var<uniform> cmd: RimDraw;

struct RimOut {
  @builtin(position) pos: vec4f,
  @location(0) r: f32,
  @location(1) delta: f32, // px from the rim, + outward
  @location(2) units: f32, // absolute angle, u32 units (anchors the fur)
}

@vertex
fn vs_rim(@builtin(vertex_index) vid: u32) -> RimOut {
  var STEP = array<i32, 6>(0, 1, 0, 1, 1, 0);
  var OUTER = array<i32, 6>(0, 0, 1, 0, 1, 1);
  let seg = i32(vid / 6u);
  let corner = vid % 6u;
  let p = clampedPoint(0u, 0xffffffffu, seg, seg + STEP[corner], cmd.k);

  var o: RimOut;
  o.delta = -cmd.reach.x;
  if (OUTER[corner] == 1) {
    o.delta = cmd.reach.y;
  }
  o.r = 1.0;
  o.units = f32(p.a);
  let onScreen = frame.rWin.x <= 1.0 + cmd.reach.y / frame.scale && frame.rWin.y >= 1.0 - cmd.reach.x / frame.scale;
  if (p.ok && onScreen) {
    o.pos = polarToClipOffset(p.a, 1.0, vec2f(o.delta, 0.0));
  } else {
    o.pos = OFF_SCREEN;
  }
  return o;
}

// One outward stroke of the fur: hashed length and brightness.
fn fur(h: f32, d: f32) -> f32 {
  let len = cmd.fur.y * (0.2 + 0.8 * h * h);
  let bright = 0.4 + 0.6 * fract(h * 61.0);
  return bright * (1.0 - ss(0.0, len, d));
}

@fragment
fn fs_rim(v: RimOut) -> @location(0) vec4f {
  let d = v.delta;
  let core = cmd.core.x * exp(-(d * d) / (cmd.core.y * cmd.core.y));
  // The inner halo has its tail at the annulus edge subtracted (and is
  // rescaled), so it reaches exactly zero there: no straight-edged step
  // where the annulus ends, however coarse its chords.
  let tail = exp(-cmd.reach.x / cmd.halo.w);
  let haloIn = cmd.halo.z * max(exp(d / cmd.halo.w) - tail, 0.0) / (1.0 - tail);
  var halo = haloIn;
  var f = 0.0;
  if (d > 0.0) {
    halo = cmd.halo.x * exp(-d / cmd.halo.y);
    let s = strands(v.units, cmd.fur.z);
    f = cmd.fur.x * mix(fur(s.x, d), fur(s.y, d), s.z);
  }
  let a = cmd.strength * (core + halo + f) * revealMask(v.r);
  // Per fragment: a chord of the ring is far longer than a sliver like Archaea.
  return vec4f(kingdomColour(u32(min(v.units, 4294967040.0))) * a, a);
}
