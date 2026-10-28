import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLAG_HOME, FLAG_NAMED, FLAG_SPECIES, FLAG_TIP, decodeTile, tileName } from './decode';

// Written by the Rust side (`make golden`) from the mini fixture tree.
const bytes = readFileSync(new URL('../../../tests/fixtures/golden_tile.bin', import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

describe('golden tile decode', () => {
  const t = decodeTile(buffer);

  it('reads the header', () => {
    expect(t.level).toBe(0);
    expect(t.sector).toBe(0);
    expect(t.count).toBe(57);
    expect(t.internalCount).toBe(27);
    expect(t.offsets.nameOff).toBe(2248); // 24 + 39·57 = 2247, padded to 4
  });

  it('views the arrays in place, without copies', () => {
    expect(t.angle.buffer).toBe(buffer);
    expect(t.r.byteOffset % 4).toBe(0);
    expect(t.nameOff.byteOffset % 4).toBe(0);
  });

  it('decodes the root', () => {
    const i = t.id.indexOf(0);
    expect(tileName(t, i)).toBe('cellular organisms');
    expect(t.parent[i]).toBe(0xffffffff);
    expect(t.leafCount[i]).toBe(30);
    expect(t.firstTip[i]).toBe(0);
    expect(t.r[i]).toBeCloseTo(0.08, 6);
    expect(t.parentR[i]).toBe(t.r[i]);
    expect(t.group[i]).toBe(255);
  });

  it('orders internal nodes first, each run by angle', () => {
    for (let i = 0; i < t.count; i++) {
      const tip = ((t.flags[i] ?? 0) & FLAG_TIP) !== 0;
      expect(tip).toBe(i >= t.internalCount);
      if (i > 0 && i !== t.internalCount) {
        expect(t.angle[i] ?? 0).toBeGreaterThanOrEqual(t.angle[i - 1] ?? 0);
      }
    }
  });

  it('decodes tips, names and flags', () => {
    const i = [...Array(t.count).keys()].find((k) => tileName(t, k) === 'Homo sapiens') ?? -1;
    expect(i).toBeGreaterThanOrEqual(t.internalCount);
    expect(t.flags[i]).toBe(FLAG_TIP | FLAG_NAMED | FLAG_SPECIES | FLAG_HOME);
    expect(t.angle[i]).toBe(2934894318);
    expect(t.arcLo[i]).toBe(t.angle[i]);
    expect(t.arcHi[i]).toBe(t.angle[i]);
    expect(t.r[i]).toBe(1);
    expect(t.childLevel[i]).toBe(255);
    expect(t.group[i]).toBe(0);
    // The unnamed mrca node has an empty name and no `named` flag.
    const mrca = [...Array(t.count).keys()].filter((k) => tileName(t, k) === '');
    expect(mrca.length).toBe(1);
    expect((t.flags[mrca[0] ?? 0] ?? 0) & FLAG_NAMED).toBe(0);
  });

  it('rejects a wrong length or magic', () => {
    expect(() => decodeTile(buffer.slice(0, buffer.byteLength - 1))).toThrow(/length/);
    const bad = buffer.slice(0);
    new Uint8Array(bad)[0] = 0;
    expect(() => decodeTile(bad)).toThrow(/magic/);
  });
});
