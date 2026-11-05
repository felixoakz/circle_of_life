import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { layoutFor } from './layout';
import { Rig } from './rig';
import {
  applyView,
  formatView,
  freeViewOf,
  linkSearch,
  parseLink,
  parseNode,
  parseView,
  rigView,
  viewFreePose,
  viewOf,
  viewPose,
} from './url';

describe('parseNode', () => {
  it('accepts OpenTree ott and mrca ids', () => {
    expect(parseNode('ott770315')).toBe('ott770315');
    expect(parseNode('mrcaott42ott4130')).toBe('mrcaott42ott4130');
  });

  it('rejects anything else', () => {
    expect(parseNode(null)).toBeNull();
    expect(parseNode('')).toBeNull();
    expect(parseNode('770315')).toBeNull();
    expect(parseNode('ott')).toBeNull();
    expect(parseNode('ott1;drop')).toBeNull();
    expect(parseNode('mrcaott42')).toBeNull();
  });
});

describe('view parameter', () => {
  it('round-trips through format and parse', () => {
    const v = { a: 1780855860.25, z: 24.1234 };
    expect(parseView(formatView(v))).toEqual(v);
  });

  it('reads a view with the pan as free view (rot defaults to 0)', () => {
    expect(parseView('1780855860,0.99999,24.1,-149.3')).toEqual({ a: 1780855860, z: 24.1, free: { r: 0.99999, rot: -149.3 } });
    expect(parseView('5,0.5,3')).toEqual({ a: 5, z: 3, free: { r: 0.5, rot: 0 } });
  });

  it('round-trips a free view through format and parse', () => {
    const v = { a: 123456789.125, z: 23.5, free: { r: 0.5123456789, rot: -42.5 } };
    expect(parseView(formatView(v))).toEqual(v);
    // A locked view keeps the short form.
    expect(formatView({ a: 5, z: 3 })).toBe('5,3');
  });

  it('turns a free view into a free pose and back, DPR-independent', () => {
    const v = { a: 2 ** 30, z: 12, free: { r: 0.5, rot: 90 } };
    const f = viewFreePose(v, 2);
    expect(f.x).toBeCloseTo(0, 12);
    expect(f.y).toBeCloseTo(0.5, 12);
    expect(f.scale).toBe(8192);
    expect(f.rot).toBeCloseTo(Math.PI / 2, 12);
    const back = freeViewOf(f, 2);
    expect(back.a).toBeCloseTo(v.a, 3);
    expect(back.z).toBeCloseTo(12, 12);
    expect(back.free?.r).toBeCloseTo(0.5, 12);
    expect(back.free?.rot).toBeCloseTo(90, 9);
  });

  it('rejects malformed views', () => {
    expect(parseView('1')).toBeNull();
    expect(parseView('1,2,3,4,5')).toBeNull();
    expect(parseView('a,b')).toBeNull();
    expect(parseView(`${2 ** 32},3`)).toBeNull();
    expect(parseView('-1,3')).toBeNull();
    expect(parseView('1,-0.5,3')).toBeNull();
  });

  it('turns into a pose and back, DPR-independent', () => {
    const v = { a: 2 ** 31, z: 10 };
    const p = viewPose(v, 2);
    expect(p.theta).toBeCloseTo(Math.PI, 12);
    expect(p.scale).toBe(2048);
    expect(viewOf(p, 2)).toEqual(v);
  });
});

describe('rig views', () => {
  const rig = (): Rig => {
    const cam = new Camera(2_385_875);
    cam.setViewport(1440, 900, 1);
    const r = new Rig(cam);
    r.setLayout(layoutFor(1440, 900));
    r.set({ theta: 1, scale: r.minScale() * 8 });
    return r;
  };

  it('writes a,z for the locked view and a,r,z,rot for free view', () => {
    const r = rig();
    expect(rigView(r).free).toBeUndefined();
    r.enterFree();
    const v = rigView(r);
    expect(v.free).toBeDefined();
    expect(formatView(v).split(',')).toHaveLength(4);
  });

  it('opens a free link in free view at the same camera', () => {
    const a = rig();
    a.enterFree();
    a.panBy(-300, 120);
    const link = parseView(formatView(rigView(a)));
    if (!link) throw new Error('no view');
    const b = rig();
    applyView(b, link);
    expect(b.isFree()).toBe(true);
    // The same picture, to well under a pixel (z has 4 decimals: 0.04 px at the corners).
    for (const [x, y] of [
      [0, 0],
      [1440, 900],
      [720, 450],
    ] as const) {
      const w = a.camera.screenToWorld(x, y);
      const pb = b.camera.worldToScreen(w.x, w.y);
      expect(Math.hypot(pb.x - x, pb.y - y)).toBeLessThan(0.05);
    }
    // A locked link leaves free view.
    applyView(b, { a: 5, z: 3 });
    expect(b.isFree()).toBe(false);
  });
});

describe('deep links', () => {
  it('parses n and v together', () => {
    const link = parseLink('?n=ott770315&v=1780855860,24.1');
    expect(link.n).toBe('ott770315');
    expect(link.v).toEqual({ a: 1780855860, z: 24.1 });
  });

  it('ignores a bad n but keeps a good v', () => {
    const link = parseLink('?n=<script>&v=1,3');
    expect(link.n).toBeNull();
    expect(link.v).not.toBeNull();
  });

  it('replaces n and v, keeps other parameters and leaves commas unescaped', () => {
    const s = linkSearch('?shot&n=ott1&debug=precision&v=1,2,3,4', {
      n: 'ott770315',
      v: { a: 5, z: 3 },
    });
    expect(s).toBe('?shot&debug=precision&n=ott770315&v=5,3');
  });

  it('drops n and v when null and returns "" when nothing is left', () => {
    expect(linkSearch('?n=ott1', { n: null, v: null })).toBe('');
    expect(linkSearch('?reduced&n=ott1', { n: null, v: null })).toBe('?reduced');
  });

  it('does not mistake other parameters that start with n or v', () => {
    expect(linkSearch('?nv=1&vx', { n: null, v: null })).toBe('?nv=1&vx');
  });

  it('round-trips a link', () => {
    const link = { n: 'mrcaott42ott4130', v: { a: 123.5, z: 9.5 } };
    expect(parseLink(linkSearch('', link))).toEqual(link);
  });
});
