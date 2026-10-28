import { describe, expect, it } from 'vitest';
import { nodeAtReticle } from './reticle';
import { decodeTile } from './tiles/decode';
import { encodeTile } from './tiles/testTile';

// root (0) → A (1, angles 100–300) → tips 2 (100) and 3 (300); B (4, a tip at 500).
const tile = decodeTile(
  encodeTile(0, 0, [
    { id: 0, parent: 0xffffffff, angle: 300, arcLo: 100, arcHi: 500, r: 0.1, parentR: 0 },
    { id: 1, parent: 0, angle: 200, arcLo: 100, arcHi: 300, r: 0.5, parentR: 0.1 },
    { id: 2, parent: 1, angle: 100, r: 1, parentR: 0.5, tip: true },
    { id: 3, parent: 1, angle: 300, r: 1, parentR: 0.5, tip: true },
    { id: 4, parent: 0, angle: 500, r: 1, parentR: 0.1, tip: true },
  ]),
);

describe('nodeAtReticle', () => {
  it('finds the root at the centre of the wheel', () => {
    expect(nodeAtReticle([tile], 200, 0.05, 13, 50)?.id).toBe(0);
  });

  it('finds the clade whose stem or subtree holds the point', () => {
    expect(nodeAtReticle([tile], 200, 0.3, 13, 50)?.id).toBe(1);
    expect(nodeAtReticle([tile], 200, 0.7, 13, 50)?.id).toBe(1); // between its two tips
    expect(nodeAtReticle([tile], 290, 0.7, 13, 50)?.id).toBe(3);
    expect(nodeAtReticle([tile], 480, 1.2, 13, 50)?.id).toBe(4);
  });

  it('ignores levels not drawn yet', () => {
    const deep = { ...tile, level: 9 };
    expect(nodeAtReticle([deep], 200, 0.7, 8, 50)).toBeNull();
  });
});
