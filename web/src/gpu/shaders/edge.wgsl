// Rim edge (DESIGN.md §5): a crisp line of `width` px from r = 1 outward,
// in the kingdom colour lifted toward white, blended "over" so it stays
// sharp on the densest glow. A thin annulus over the visible part of the
// circle, cut into K steps like the rim ring (rim.wgsl). Port of edge.vert
// and edge.frag.

@group(1) @binding(0) var<uniform> cmd: EdgeDraw;

struct EdgeOut {
  @builtin(position) pos: vec4f,
  @location(0) delta: f32, // px from the rim, + outward
  @location(1) units: f32, // absolute angle, u32 units
}

@vertex
fn vs_edge(@builtin(vertex_index) vid: u32) -> EdgeOut {
  var STEP = array<i32, 6>(0, 1, 0, 1, 1, 0);
  var OUTER = array<i32, 6>(0, 0, 1, 0, 1, 1);
  let seg = i32(vid / 6u);
  let corner = vid % 6u;
  let p = clampedPoint(0u, 0xffffffffu, seg, seg + STEP[corner], cmd.k);

  var o: EdgeOut;
  o.delta = -cmd.reach.x;
  if (OUTER[corner] == 1) {
    o.delta = cmd.reach.y;
  }
  o.units = f32(p.a);
  let onScreen = frame.rWin.x <= 1.0 + cmd.reach.y / frame.scale && frame.rWin.y >= 1.0 - cmd.reach.x / frame.scale;
  if (p.ok && onScreen) {
    o.pos = polarToClipOffset(p.a, 1.0, vec2f(o.delta, 0.0));
  } else {
    o.pos = OFF_SCREEN;
  }
  return o;
}

@fragment
fn fs_edge(v: EdgeOut) -> @location(0) vec4f {
  let cov = clamp(0.5 + min(v.delta, cmd.width - v.delta), 0.0, 1.0);
  let a = cmd.alpha * cov * revealMask(1.0);
  let c = mix(kingdomColour(u32(min(v.units, 4294967040.0))), vec3f(1.0), cmd.lift);
  return vec4f(c * a, a);
}
