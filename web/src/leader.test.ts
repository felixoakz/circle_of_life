import { describe, expect, it } from 'vitest';
import { roomToEdge } from './leader';

describe('roomToEdge', () => {
  it('measures to the gutter along the direction', () => {
    // From x = 300 going right on a 390 px phone: 390 - 16 - 300.
    expect(roomToEdge(300, 400, 1, 0, 390, 844, 16)).toBeCloseTo(74);
    expect(roomToEdge(100, 400, -1, 0, 390, 844, 16)).toBeCloseTo(84);
    // Diagonal: the nearer edge wins.
    expect(roomToEdge(200, 100, Math.SQRT1_2, -Math.SQRT1_2, 390, 844, 16)).toBeCloseTo(84 / Math.SQRT1_2);
  });
});
