// WebGL2 context creation and shader program helpers (canvas sizing is
// shared with WebGPU, in render/canvas.ts).

/** Returns a WebGL2 context, or null when the browser cannot provide one. */
export function createGL(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  return canvas.getContext('webgl2', {
    // The alpha channel is the saturating blend's light counter (renderer.ts).
    // Colours are premultiplied, and the page behind is black, so the
    // composited result is the same as an opaque canvas.
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(`shader compile failed:\n${log}`);
  }
  return shader;
}

/** A linked program plus its uniform locations, looked up once by name. */
export interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // The shaders are no longer needed once linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed:\n${gl.getProgramInfoLog(program) ?? ''}`);
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) u[info.name] = gl.getUniformLocation(program, info.name);
  }
  return { program, u };
}
