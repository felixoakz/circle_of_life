// Easing curves for the few animations (DESIGN.md §6).

/** GLSL-style smoothstep: 0 below e0, 1 above e1, smooth in between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Symmetric cubic ease-in-out. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` as a function of t ∈ [0, 1]: solves
 * x(s) = t for the curve parameter s by bisection (x is monotone because
 * x1, x2 ∈ [0, 1]), then returns y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bez = (a: number, b: number, s: number): number => {
    const u = 1 - s;
    return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
  };
  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (bez(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return bez(y1, y2, (lo + hi) / 2);
  };
}
