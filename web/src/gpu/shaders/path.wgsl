// Highlighted paths (PLAN §7.3 pass 5): the hover and selection paths,
// root → node, as quads a few px wide. Port of path.vert and path.frag.
// One instance per segment (path.ts): an arc (span > 0, at radius r0) or a
// radial segment (span = 0, r0 → r1), cut into K steps; each step is a quad
// of 6 vertices between two points that go through the precise
// camera-relative transform, then widened in screen px.
//
// Group 2 is this path's storage buffer (4 words per segment: a0, span,
// r0 and r1 as f32 bits), bound to the shared `tile` array of tile.wgsl.
// Blend (one, one − src alpha): opaque over the tree, so overlapping steps
// do not add up.

@group(1) @binding(0) var<uniform> cmd: PathDraw;

const PATH_WORDS: u32 = 4u;

struct PathOut {
  @builtin(position) pos: vec4f,
  @location(0) across: f32, // px from the centre line
}

// Result of pathPoint (GLSL wrote the point through an `out` parameter).
struct PathPoint {
  ok: bool,
  p: vec2f, // device px from the screen centre
}

// Point j of segment i; `ok` is false when the arc's step is off screen.
fn pathPoint(i: u32, seg: i32, j: i32) -> PathPoint {
  let a0 = tile[i * PATH_WORDS];
  let span = tile[i * PATH_WORDS + 1u];
  let r0 = bitcast<f32>(tile[i * PATH_WORDS + 2u]);
  let r1 = bitcast<f32>(tile[i * PATH_WORDS + 3u]);
  if (span == 0u) {
    let r = clamp(mix(r0, r1, f32(j) / f32(cmd.k)), frame.rWin.x, frame.rWin.y);
    return PathPoint(true, polarToClip(a0, r).xy * frame.half);
  }
  let c = clampedPoint(a0, span, seg, j, cmd.k);
  return PathPoint(c.ok, polarToClip(c.a, r0).xy * frame.half);
}

@vertex
fn vs_path(@builtin(vertex_index) vid: u32, @builtin(instance_index) i: u32) -> PathOut {
  let seg = i32(vid / 6u);
  let corner = vid % 6u;
  // Two triangles: (0,−) (1,−) (0,+) / (0,+) (1,−) (1,+).
  let atEnd = corner == 1u || corner == 4u || corner == 5u;
  var side = -1.0;
  if (corner == 2u || corner == 3u || corner == 5u) {
    side = 1.0;
  }
  let q0 = pathPoint(i, seg, seg);
  let q1 = pathPoint(i, seg, seg + 1);
  let d = q1.p - q0.p;
  let len = length(d);
  let r0 = bitcast<f32>(tile[i * PATH_WORDS + 2u]);
  let r1 = bitcast<f32>(tile[i * PATH_WORDS + 3u]);

  var o: PathOut;
  if (!q0.ok || !q1.ok || len < 1e-3 || r1 < r0) {
    o.pos = OFF_SCREEN;
    o.across = 0.0;
    return o;
  }
  let dir = d / len;
  let nrm = vec2f(-dir.y, dir.x);
  let w = cmd.halfW + 1.0; // room for antialiasing
  // Each step runs on by half a width at both ends, so joints and corners
  // close; the path is opaque, so the overlaps do not show.
  var p = q0.p - dir * cmd.halfW;
  if (atEnd) {
    p = q1.p + dir * cmd.halfW;
  }
  p += nrm * side * w;
  o.across = side * w;
  o.pos = vec4f(p / frame.half, 0.0, 1.0);
  return o;
}

// An opaque flat colour with an antialiased edge. Alpha scales the
// brightness, not the opacity, so "text-1 at 60%" stays a solid grey that
// reads over bright tip bars.
@fragment
fn fs_path(v: PathOut) -> @location(0) vec4f {
  let cov = clamp(cmd.halfW + 0.5 - abs(v.across), 0.0, 1.0);
  return vec4f(cmd.colour.rgb * cmd.colour.a * cov, cov);
}
