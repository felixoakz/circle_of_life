// `?debug=parity` (gpu/parity.ts): compute entry points that run the shared
// shader functions on fixed inputs, so TS can compare them with its own
// double-precision references. gpu/pipelines.ts `withShared` puts the
// generated structs, common.wgsl, palette.wgsl, frag.wgsl and tile.wgsl in
// front of this file, exactly as for the render pipelines, so these are the
// very functions the tree is drawn with.
//
// Each invocation handles one input: four u32 words (floats are passed as
// their bits and `bitcast` back), and writes one vec4f. Group 0 is the same
// `frame` and `palette` the render pipelines read (common.wgsl); group 1 is
// this page's own input and output.

@group(1) @binding(0) var<storage, read> inputs: array<vec4u>;
@group(1) @binding(1) var<storage, read_write> outputs: array<vec4f>;

// Input word `lane` of item i, read as a float.
fn inputF32(i: u32, lane: u32) -> f32 {
  return bitcast<f32>(inputs[i][lane]);
}

// `@workgroup_size(64)`: the GPU runs invocations in groups of 64; the TS
// side dispatches ceil(n / 64) groups, so the last group can run past the
// end of the inputs and must stop there.

// x = angle (u32 units) → kingdom colour.
@compute @workgroup_size(64)
fn cs_kingdom(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  outputs[i] = vec4f(kingdomColour(inputs[i].x), 0.0);
}

// (angle u32, r f32, offset x f32, offset y f32) → clip position.
@compute @workgroup_size(64)
fn cs_polar(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  outputs[i] = polarToClipOffset(inputs[i].x, inputF32(i, 1u), vec2f(inputF32(i, 2u), inputF32(i, 3u)));
}

// x (u32) → hash(x).
@compute @workgroup_size(64)
fn cs_hash(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  outputs[i] = vec4f(hash(inputs[i].x), 0.0, 0.0, 0.0);
}

// (units f32, px f32) → strands(units, px).
@compute @workgroup_size(64)
fn cs_strands(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  outputs[i] = vec4f(strands(inputF32(i, 0u), inputF32(i, 1u)), 0.0);
}

// x (f32) → (sinPrecise(x), the built-in sin(x)), to show why sinPrecise exists.
@compute @workgroup_size(64)
fn cs_sin(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&inputs)) {
    return;
  }
  let x = inputF32(i, 0u);
  outputs[i] = vec4f(sinPrecise(x), sin(x), 0.0, 0.0);
}
