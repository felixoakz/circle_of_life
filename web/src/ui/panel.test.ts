import { describe, expect, it } from 'vitest';
import type { LineageEntry, NodeInfo } from '../types';
import { contextAncestor } from './panel';

function entry(id: number, name: string | null, rank: string | null): LineageEntry {
  return { id, nodeId: `ott${id}`, name, rank, group: 0, angle: 0, r: 0.5 };
}

function node(lineage: LineageEntry[]): NodeInfo {
  return { lineage } as unknown as NodeInfo;
}

describe('contextAncestor', () => {
  it('takes the nearest named clade above genus, unranked ones included', () => {
    // Homo sapiens' real lineage (tail): no Hominidae node in synth 16.1.
    const n = node([
      entry(0, 'cellular organisms', 'no rank'),
      entry(10, 'Mammalia', 'class'),
      entry(11, 'Primates', 'no rank'),
      entry(12, 'Homininae', 'subfamily'),
      entry(13, null, null),
      entry(14, 'Homo', 'genus'),
    ]);
    expect(contextAncestor(n)?.name).toBe('Homininae');
  });

  it('skips placeholders and the root, and falls back to Life', () => {
    expect(contextAncestor(node([entry(0, 'cellular organisms', 'no rank'), entry(5, 'Primates', 'no rank'), entry(6, 'Hominidae incertae sedis', 'no rank')]))?.name).toBe('Primates');
    expect(contextAncestor(node([entry(0, 'cellular organisms', 'no rank'), entry(7, 'Homo', 'genus')]))?.name).toBe('Homo');
    expect(contextAncestor(node([entry(0, 'cellular organisms', 'no rank')]))?.id).toBe(0);
  });
});
