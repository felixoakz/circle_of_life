import { describe, expect, it } from 'vitest';
import { tabAfterKey, tabToShow } from './tabs';

describe('tabs', () => {
  it('moves with the arrow keys, wrapping, and jumps with Home and End', () => {
    const shown = ['overview', 'range', 'tree'] as const;
    expect(tabAfterKey(shown, 'overview', 'ArrowRight')).toBe('range');
    expect(tabAfterKey(shown, 'tree', 'ArrowRight')).toBe('overview');
    expect(tabAfterKey(shown, 'overview', 'ArrowLeft')).toBe('tree');
    expect(tabAfterKey(shown, 'range', 'Home')).toBe('overview');
    expect(tabAfterKey(shown, 'range', 'End')).toBe('tree');
    expect(tabAfterKey(shown, 'range', 'Enter')).toBeNull();
    // A hidden tab is skipped.
    expect(tabAfterKey(['overview', 'tree'], 'overview', 'ArrowRight')).toBe('tree');
  });

  it('keeps the visitor’s tab when the next node has it, else Overview', () => {
    expect(tabToShow(['overview', 'range', 'tree'], 'range')).toBe('range');
    expect(tabToShow(['overview', 'tree'], 'range')).toBe('overview');
    expect(tabToShow(['tree'], 'range')).toBe('tree');
    expect(tabToShow([], 'tree')).toBeNull();
  });
});
