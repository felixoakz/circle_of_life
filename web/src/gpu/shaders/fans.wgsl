// Frontier fans (tiles/fans.ts): the undrawn children of a drawn node, as a
// band from the node's radius to the rim that fs_fans breaks into fine
// strands. Port of fans.vert and fans.frag.
//
// New WGSL/WebGPU ideas here:
// - Group 2 is the fan list, not a tile: the same `tile: array<u32>`
//   binding (tile.wgsl) points at a storage buffer of 4 words per fan
//   (lo, hi, r as f32 bits, info). The pipeline layout only says "a
//   read-only storage buffer of u32", so any such buffer fits.
// - `instance_index` already includes the draw's `firstInstance`, so the
//   narrow fans (drawn second, starting at fan `wide`) read their own words
//   without the attribute re-pointing WebGL needed.
// - Constant arrays indexed by a runtime value must be function-local
//   `var`s: indexing a `const` array needs a constant index.
// - A triangle-list: every 3 vertices make a triangle; K steps × 2
//   triangles = 6K vertices per fan.

@group(1) @binding(0) var<uniform> cmd: FansDraw;

const FAN_WORDS: u32 = 4u;

struct FanOut {
  @builtin(position) pos: vec4f,
  @location(0) r: f32,
  @location(1) hue: vec3f,
  @location(2) alpha: f32,
  @location(3) t: f32,     // 0 at the node's radius, 1 at the rim
  @location(4) units: f32, // angle from the fan's start, u32 units
}

@vertex
fn vs_fans(@builtin(vertex_index) vid: u32, @builtin(instance_index) i: u32) -> FanOut {
  // Per corner of the two triangles: step offset (0 or 1) and inner/outer edge.
  var STEP = array<i32, 6>(0, 1, 0, 1, 1, 0);
  var OUTER = array<i32, 6>(0, 0, 1, 0, 1, 1);
  let seg = i32(vid / 6u);
  let corner = vid % 6u;

  let lo = tile[i * FAN_WORDS];
  let hi = tile[i * FAN_WORDS + 1u];
  let fanR = bitcast<f32>(tile[i * FAN_WORDS + 2u]);
  let info = tile[i * FAN_WORDS + 3u]; // level | 0x100 when fading out with level F
  let p = clampedPoint(lo, hi - lo, seg, seg + STEP[corner], cmd.k);

  let level = f32(info & 0xffu);
  var fade = 1.0;
  if (level != 0.0) {
    fade = ss(level, level + 0.6, cmd.lambda);
  }
  if ((info & 0x100u) != 0u) {
    fade *= 1.0 - cmd.fadeF;
  }

  var rr = fanR;
  if (OUTER[corner] == 1) {
    rr = 1.0;
  }
  let r = clamp(rr, frame.rWin.x, frame.rWin.y);

  var o: FanOut;
  o.r = r;
  o.hue = kingdomColour(p.a);
  o.alpha = fade * cmd.alpha;
  o.t = clamp((r - fanR) / max(1.0 - fanR, 1e-6), 0.0, 1.0);
  o.units = f32(p.a - lo);
  if (p.ok && fade > 0.0 && fanR < frame.rWin.y) {
    o.pos = polarToClip(p.a, r);
  } else {
    o.pos = OFF_SCREEN;
  }
  return o;
}

// Strand with hash h at depth t: it starts at a hashed point along the fan
// (most start late) and has its own brightness.
fn strand(h: f32, t: f32) -> f32 {
  let start = 0.92 * (1.0 - h * h);
  let bright = 0.35 + 0.65 * fract(h * 97.0);
  return ss(start, start + 0.08, t) * bright;
}

// Bundles of fine lines rather than flat polygons: each hashed strand
// stands for a lineage branching off between the node and the rim.
@fragment
fn fs_fans(v: FanOut) -> @location(0) vec4f {
  let s = strands(v.units, cmd.linePx);
  let k = mix(strand(s.x, v.t), strand(s.y, v.t), s.z);
  let a = v.alpha * k * extRamp(v.t, v.r) * rimBoost(v.r) * revealMask(v.r);
  return vec4f(tint(v.hue, v.r) * a, a);
}
