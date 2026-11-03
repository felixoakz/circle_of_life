import { describe, expect, it } from 'vitest';
import { navMove, navTarget } from './nav';
import type { ChildEntry, LineageEntry, NodeInfo } from './types';

const entry = (id: number): LineageEntry => ({ id, nodeId: `ott${id}`, name: `N${id}`, rank: null, group: 0, angle: 0, r: 0 });
const child = (id: number, leafCount: number): ChildEntry => ({
  id,
  nodeId: `ott${id}`,
  name: `C${id}`,
  rank: null,
  group: 0,
  leafCount,
});

function node(id: number, lineage: number[], children: ChildEntry[]): NodeInfo {
  return {
    id,
    nodeId: `ott${id}`,
    name: `N${id}`,
    rank: null,
    group: 0,
    flags: 0,
    leafCount: 1,
    childCount: children.length,
    angle: 0,
    arcLo: 0,
    arcHi: 0,
    r: 0.5,
    level: 0,
    ids: { ott: id, gbif: null, ncbi: null },
    lineage: lineage.map(entry),
    children: { total: children.length, top: children },
    namedAncestor: null,
    commonName: null,
  };
}

// Root 0 → parent 1 → children 10 (largest), 11, 12 (smallest).
const parent = node(1, [0], [child(10, 30), child(11, 20), child(12, 10)]);
const middle = node(11, [0, 1], [child(20, 15), child(21, 5)]);

describe('navMove', () => {
  it('maps the arrow keys and Backspace', () => {
    expect(navMove('ArrowUp')).toBe('parent');
    expect(navMove('Backspace')).toBe('parent');
    expect(navMove('ArrowDown')).toBe('child');
    expect(navMove('ArrowLeft')).toBe('prev');
    expect(navMove('ArrowRight')).toBe('next');
    expect(navMove('Enter')).toBeNull();
  });
});

describe('navTarget', () => {
  it('goes up to the parent and down to the largest child', () => {
    expect(navTarget('parent', middle, null)).toBe(1);
    expect(navTarget('child', middle, null)).toBe(20);
  });

  it('has nowhere to go above the root or below a tip', () => {
    expect(navTarget('parent', node(0, [], [child(1, 5)]), null)).toBeNull();
    expect(navTarget('child', node(99, [0], []), null)).toBeNull();
  });

  it('steps through siblings in the listed order, wrapping round', () => {
    expect(navTarget('next', middle, parent)).toBe(12);
    expect(navTarget('prev', middle, parent)).toBe(10);
    expect(navTarget('next', node(12, [0, 1], []), parent)).toBe(10);
    expect(navTarget('prev', node(10, [0, 1], []), parent)).toBe(12);
  });

  it('needs the parent for sibling moves', () => {
    expect(navTarget('next', middle, null)).toBeNull();
  });

  it('an only child has no siblings', () => {
    const only = node(5, [0], [child(6, 1)]);
    expect(navTarget('next', node(6, [0, 5], []), only)).toBeNull();
  });

  it('from outside the listed siblings, goes to the largest or the smallest', () => {
    const unlisted = node(77, [0, 1], []);
    expect(navTarget('next', unlisted, parent)).toBe(10);
    expect(navTarget('prev', unlisted, parent)).toBe(12);
  });
});

describe('navTarget: unnamed ancestors', () => {
  it('steps over unnamed nodes on the way up', () => {
    const n = node(30, [0, 1, 2], []);
    const unnamed = n.lineage[2];
    if (unnamed) unnamed.name = null;
    expect(navTarget('parent', n, null)).toBe(1);
  });
});
