// Keyboard tree navigation (DESIGN.md §8, PLAN §7.11), as plain functions:
// with a node selected, ↑ (or Backspace) selects its nearest named ancestor
// (unnamed mrca nodes and OTT placeholders are stepped over), ↓ its largest
// child, ← and → its siblings. Siblings are taken in the order the panel
// lists children (largest first, `/api/nodes` children.top), so → steps to
// the next smaller sibling and ← back, wrapping round. In a polytomy only
// the 50 largest are listed; from a node outside them, → goes to the
// largest and ← to the smallest listed.

import { isPlaceholderName } from './names';
import type { NodeInfo } from './types';

export type NavMove = 'parent' | 'child' | 'prev' | 'next';

/** The move a key asks for, or null for keys that do not navigate. */
export function navMove(key: string): NavMove | null {
  switch (key) {
    case 'ArrowUp':
    case 'Backspace':
      return 'parent';
    case 'ArrowDown':
      return 'child';
    case 'ArrowLeft':
      return 'prev';
    case 'ArrowRight':
      return 'next';
    default:
      return null;
  }
}

/**
 * The pre-order id to select after `move` from `node`, or null when there is
 * nowhere to go. Sibling moves need the parent (`parent`, its own
 * `/api/nodes` answer); the others do not.
 */
export function navTarget(move: NavMove, node: NodeInfo, parent: NodeInfo | null): number | null {
  if (move === 'parent') {
    for (let i = node.lineage.length - 1; i >= 0; i--) {
      const a = node.lineage[i];
      if (a && (a.id === 0 || (a.name && !isPlaceholderName(a.name)))) return a.id;
    }
    return null;
  }
  if (move === 'child') return node.children.top[0]?.id ?? null;
  const sibs = parent?.children.top ?? [];
  if (sibs.length === 0) return null;
  const i = sibs.findIndex((c) => c.id === node.id);
  if (i < 0) return (move === 'next' ? sibs[0] : sibs[sibs.length - 1])?.id ?? null;
  if (sibs.length === 1) return null;
  const j = (i + (move === 'next' ? 1 : -1) + sibs.length) % sibs.length;
  return sibs[j]?.id ?? null;
}
