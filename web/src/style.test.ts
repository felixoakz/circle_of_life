import { describe, expect, it } from 'vitest';
import { BRANCH_ALPHA, BRANCH_ALPHA_DEEP, GLOW_DEEP, TIP_BAR_MAX_W_PX, frameLook } from './style';

describe('frameLook', () => {
  it('glows most on the whole wheel and shows no tip bars there', () => {
    const l = frameLook({ lambda: 3.4, tipSpacing: 0.001 });
    expect(l.glow).toBe(1);
    expect(l.ring).toBe(1);
    expect(l.tipBar).toBe(0);
    expect(l.leader).toBe(0);
    expect(l.branchAlpha).toBe(BRANCH_ALPHA);
  });

  it('trades the rim ring for bright tip bars at deep zoom', () => {
    const l = frameLook({ lambda: 18.8, tipSpacing: 48 });
    expect(l.glow).toBeCloseTo(GLOW_DEEP);
    expect(l.ring).toBe(0);
    expect(l.tipBar).toBeGreaterThan(0.9);
    expect(l.tipWidth).toBe(TIP_BAR_MAX_W_PX);
    expect(l.leader).toBe(1);
    expect(l.branchAlpha).toBe(BRANCH_ALPHA_DEEP);
  });

  it('keeps tip bars at least 1 px wide', () => {
    expect(frameLook({ lambda: 12.5, tipSpacing: 0.5 }).tipWidth).toBe(1);
  });
});
