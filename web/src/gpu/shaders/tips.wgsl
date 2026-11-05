// Tip dots (DESIGN.md §5): a small filled dot where each tip's line meets
// the rim, one screen-aligned quad per node (a 4-vertex triangle-strip, as
// in marks.wgsl), sized in device px so it keeps its size at any zoom.
// Internal nodes are moved off screen. The quad is placed with
// polarToClipOffset, exact at max zoom. Blended "over", so the dot keeps its
// colour where it covers its line. Port of tips.vert and tips.frag.

@group(1) @binding(0) var<uniform> cmd: TipsDraw;

struct TipOut {
  @builtin(position) pos: vec4f,
  @location(0) off: vec2f, // px from the dot's centre
  @location(1) colour: vec3f,
}

@vertex
fn vs_tips(@builtin(vertex_index) corner: u32, @builtin(instance_index) i: u32) -> TipOut {
  let c = vec2f(select(-1.0, 1.0, (corner & 1u) != 0u), select(-1.0, 1.0, (corner & 2u) != 0u));
  let ext = cmd.radius + 1.0; // room for antialiasing
  let nodeAngle = tileAngle(i);
  let childLevel = tileChildLevel(i);
  let parent = tileParent(i);
  var angle = nodeAngle;
  var show = childLevel == 255u;
  if (isHomeChildTip(childLevel, parent)) {
    // One dot for Homo sapiens' row, as with its bar (marks.wgsl).
    angle = frame.homeAngle;
    show = nodeAngle <= frame.homeAngle;
  }
  let near = frame.rWin.x < 1.0 + ext / frame.scale && frame.rWin.y > 1.0 - ext / frame.scale;
  var o: TipOut;
  o.off = c * ext;
  o.colour = select(mix(kingdomColour(angle), vec3f(1.0), cmd.lift), vec3f(1.0), isHome(tileFlags(i), parent));
  if (show && near) {
    o.pos = polarToClipOffset(angle, 1.0, o.off);
  } else {
    o.pos = OFF_SCREEN;
  }
  return o;
}

@fragment
fn fs_tips(v: TipOut) -> @location(0) vec4f {
  let cov = clamp(cmd.radius + 0.5 - length(v.off), 0.0, 1.0);
  let a = cmd.alpha * cov * revealMask(1.0);
  return vec4f(v.colour * a, a);
}
