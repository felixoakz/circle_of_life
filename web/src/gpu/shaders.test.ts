// Static checks of the WGSL sources (docs/plan-webgpu.md §3 item 6). They
// read gpu/shaders/ from disk, so they fail until W3/W4 write the shaders.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_RUNS } from '../palette';
import { PASSES, PASS_BLEND } from '../render/plan';
import { structLayout, wgslStruct } from './layout';
import { PIPELINES, SHARED_MODULES } from './pipelines';
import { FRAME_FIELDS, PALETTE_FIELDS } from './uniforms';

const DIR = new URL('./shaders/', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, DIR), 'utf8');
const MODULES = [...new Set([...SHARED_MODULES, ...PIPELINES.map((p) => p.module)])];

/** WGSL without comments, so the checks only see code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** What pipelines.ts will feed to createShaderModule: generated structs, shared modules, body. */
function concatenated(module: string): string {
  const structs =
    wgslStruct('Frame', structLayout(FRAME_FIELDS)) + wgslStruct('Palette', structLayout(PALETTE_FIELDS));
  return [structs, ...SHARED_MODULES.map(read), read(module)].join('\n');
}

describe('pipeline table', () => {
  it('covers every pass of the frame plan once (lines share a module)', () => {
    expect(PIPELINES.map((p) => p.pass).sort()).toEqual([...PASSES].sort());
  });

  it('bakes the blend the plan gives each pass', () => {
    for (const p of PIPELINES) expect(p.blend).toBe(PASS_BLEND[p.pass]);
  });
});

describe('WGSL sources', () => {
  it('every module exists', () => {
    for (const m of MODULES) expect(existsSync(new URL(m, DIR)), m).toBe(true);
  });

  it('MAX_RUNS matches palette.ts', () => {
    const m = /const\s+MAX_RUNS\s*(?::\s*\w+\s*)?=\s*(\d+)[ui]?\s*;/.exec(code(read('palette.wgsl')));
    expect(m, 'palette.wgsl declares const MAX_RUNS').not.toBeNull();
    expect(Number(m?.[1])).toBe(MAX_RUNS);
  });

  it('no smoothstep with reversed literal edges (use ss() from common.wgsl)', () => {
    const literal = /smoothstep\(\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*,\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*,/g;
    for (const m of MODULES) {
      for (const hit of code(read(m)).matchAll(literal)) {
        expect(Number(hit[1]), `${m}: ${hit[0]}`).toBeLessThan(Number(hit[2]));
      }
    }
  });

  it('common.wgsl defines the ss() helper', () => {
    expect(code(read('common.wgsl'))).toMatch(/\bfn\s+ss\s*\(/);
  });

  it('every module concatenates: balanced braces, no function or struct defined twice', () => {
    for (const p of PIPELINES) {
      const src = code(concatenated(p.module));
      const opens = (src.match(/\{/g) ?? []).length;
      const closes = (src.match(/\}/g) ?? []).length;
      expect(opens, `${p.module} braces`).toBe(closes);
      const names = [...src.matchAll(/\b(?:fn|struct)\s+(\w+)/g)].map((h) => h[1]);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes, `${p.module} duplicate definitions`).toEqual([]);
    }
  });

  it('every entry point named in pipelines.ts exists with its stage attribute', () => {
    for (const p of PIPELINES) {
      const src = code(read(p.module));
      expect(src, `${p.module}: @vertex fn ${p.vertex}`).toMatch(new RegExp(`@vertex\\s+fn\\s+${p.vertex}\\s*\\(`));
      expect(src, `${p.module}: @fragment fn ${p.fragment}`).toMatch(
        new RegExp(`@fragment\\s+fn\\s+${p.fragment}\\s*\\(`),
      );
    }
  });
});
