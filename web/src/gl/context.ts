// WebGL2 context creation, canvas sizing and shader program helpers.

/** Backing-store size in device pixels for a canvas of the given CSS size. */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { width: number; height: number } {
  // Round (not floor) so a 0.5px rounding error on fractional DPRs (1.25, 1.5)
  // does not leave a 1px blurry seam; clamp to 1 so GL never gets a 0-size buffer.
  return {
    width: Math.max(1, Math.round(cssWidth * devicePixelRatio)),
    height: Math.max(1, Math.round(cssHeight * devicePixelRatio)),
  };
}

/**
 * Device pixels per CSS px for the tree canvas: the screen's DPR, lowered
 * so the backing store holds at most `maxPixels` (PLAN §7.12). A 5K screen
 * (5120×2880 device px, 14.7 Mpx) took 11–13 ms per overview frame on an
 * integrated GPU, and the fill-bound passes (ring, fans, marks) scale with
 * the pixel count (measurements at `MAX_BACKING_PX`). Never below 1, so a
 * big DPR-1 screen keeps its full resolution.
 */
export function treeDpr(cssWidth: number, cssHeight: number, dpr: number, maxPixels: number): number {
  const area = Math.max(1, cssWidth * cssHeight);
  const cap = Math.sqrt(maxPixels / area);
  return Math.max(Math.min(dpr, 1), Math.min(dpr, cap));
}

/** Resizes the canvas's backing store to match its CSS box. Returns true if it changed. */
export function fitCanvas(canvas: HTMLCanvasElement, devicePixelRatio: number): boolean {
  const { width, height } = backingStoreSize(
    canvas.clientWidth,
    canvas.clientHeight,
    devicePixelRatio,
  );
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

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
