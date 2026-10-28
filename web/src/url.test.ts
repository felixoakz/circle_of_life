import { describe, expect, it } from 'vitest';
import { formatView, linkSearch, parseLink, parseNode, parseView } from './url';

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
    const v = { a: 1780855860.25, r: 0.9999912345, z: 24.1234, rot: -149.3 };
    expect(parseView(formatView(v))).toEqual(v);
  });

  it('rejects malformed views', () => {
    expect(parseView('1,2')).toBeNull();
    expect(parseView('1,2,3,4,5')).toBeNull();
    expect(parseView('a,b,c')).toBeNull();
    expect(parseView(`${2 ** 32},0.5,3`)).toBeNull();
    expect(parseView('1,-0.5,3')).toBeNull();
  });
});

describe('deep links', () => {
  it('parses n and v together', () => {
    const link = parseLink('?n=ott770315&v=1780855860,0.99999,24.1,-149.3');
    expect(link.n).toBe('ott770315');
    expect(link.v).toEqual({ a: 1780855860, r: 0.99999, z: 24.1, rot: -149.3 });
  });

  it('ignores a bad n but keeps a good v', () => {
    const link = parseLink('?n=<script>&v=1,0.5,3,0');
    expect(link.n).toBeNull();
    expect(link.v).not.toBeNull();
  });

  it('replaces n and v, keeps other parameters and leaves commas unescaped', () => {
    const s = linkSearch('?shot&n=ott1&debug=precision&v=1,2,3,4', {
      n: 'ott770315',
      v: { a: 5, r: 0.5, z: 3, rot: 0 },
    });
    expect(s).toBe('?shot&debug=precision&n=ott770315&v=5,0.5,3,0');
  });

  it('drops n when nothing is selected and returns "" when nothing is left', () => {
    expect(linkSearch('?n=ott1', { n: null, v: null })).toBe('');
    expect(linkSearch('?reduced&n=ott1', { n: null, v: null })).toBe('?reduced');
  });

  it('does not mistake other parameters that start with n or v', () => {
    expect(linkSearch('?nv=1&vx', { n: null, v: null })).toBe('?nv=1&vx');
  });

  it('round-trips a link', () => {
    const link = { n: 'mrcaott42ott4130', v: { a: 123.5, r: 0.75, z: 9.5, rot: 12 } };
    expect(parseLink(linkSearch('', link))).toEqual(link);
  });
});
