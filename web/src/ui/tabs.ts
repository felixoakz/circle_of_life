// The card's tabs (DESIGN.md §4.2): Overview, Range and Tree, under the
// card's head. The WAI-ARIA tabs pattern: a `tablist` of `tab` buttons, each
// controlling a `tabpanel`; one tab is in the Tab order at a time (roving
// tabindex), ←/→ move between the shown tabs and activate them, Home and
// End jump to the ends. A tab with nothing to show is hidden.
//
// The panels share one area of fixed size (`body`): only the active one is
// shown, and nothing in it scrolls (ui/fit.ts makes the content fit).

export type TabId = 'overview' | 'range' | 'tree';

const TAB_LABELS: Readonly<Record<TabId, string>> = {
  overview: 'Overview',
  range: 'Range',
  tree: 'Tree',
};

const ORDER: readonly TabId[] = ['overview', 'range', 'tree'];

/** The tab a key moves to among the `shown` ones (wrapping), or null for other keys. */
export function tabAfterKey(shown: readonly TabId[], current: TabId, key: string): TabId | null {
  if (shown.length === 0) return null;
  const i = Math.max(0, shown.indexOf(current));
  switch (key) {
    case 'ArrowRight':
      return shown[(i + 1) % shown.length] ?? null;
    case 'ArrowLeft':
      return shown[(i - 1 + shown.length) % shown.length] ?? null;
    case 'Home':
      return shown[0] ?? null;
    case 'End':
      return shown[shown.length - 1] ?? null;
    default:
      return null;
  }
}

/** The tab to show: the one the visitor chose if it is there, else Overview, else the first shown. */
export function tabToShow(shown: readonly TabId[], preferred: TabId): TabId | null {
  if (shown.includes(preferred)) return preferred;
  if (shown.includes('overview')) return 'overview';
  return shown[0] ?? null;
}

interface Tab {
  tab: HTMLButtonElement;
  panel: HTMLElement;
}

export class Tabs {
  readonly list: HTMLElement;
  readonly body: HTMLElement;
  /** The visitor picked a tab (by click or key); the card keeps it for the next selections. */
  onPick: (id: TabId) => void = () => {};
  /** A tab was shown (the card fits its content then). */
  onShow: (id: TabId) => void = () => {};
  private readonly tabs = new Map<TabId, Tab>();
  private shownIds: TabId[] = [];
  private current: TabId | null = null;

  constructor() {
    this.list = document.createElement('div');
    this.list.className = 'panel-tabs';
    this.list.setAttribute('role', 'tablist');
    this.list.setAttribute('aria-label', 'About this taxon');
    this.body = document.createElement('div');
    this.body.className = 'panel-tabbody';
    for (const id of ORDER) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'panel-tab';
      tab.id = `panel-tab-${id}`;
      tab.textContent = TAB_LABELS[id];
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `panel-pane-${id}`);
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;
      tab.addEventListener('click', () => this.pick(id, false));
      const panel = document.createElement('div');
      panel.className = 'panel-pane';
      panel.id = `panel-pane-${id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.hidden = true;
      this.tabs.set(id, { tab, panel });
      this.list.append(tab);
      this.body.append(panel);
    }
    this.list.addEventListener('keydown', (e) => {
      if (!this.current) return;
      const next = tabAfterKey(this.shownIds, this.current, e.key);
      if (!next) return;
      // The tabs' own arrows: the tree's (selection.ts) do not see them.
      e.preventDefault();
      e.stopPropagation();
      this.pick(next, true);
    });
  }

  /** The panel element of tab `id`. */
  panel(id: TabId): HTMLElement {
    const t = this.tabs.get(id);
    if (!t) throw new Error(`no tab ${id}`);
    return t.panel;
  }

  /** The tabs on show, in order. */
  shown(): readonly TabId[] {
    return this.shownIds;
  }

  active(): TabId | null {
    return this.current;
  }

  /** Shows only the tabs in `ids` and selects `active` among them (never moves focus). */
  set(ids: readonly TabId[], active: TabId | null): void {
    this.shownIds = ORDER.filter((id) => ids.includes(id));
    for (const [id, t] of this.tabs) t.tab.hidden = !this.shownIds.includes(id);
    // A single tab is no choice: the row goes, the panel stays.
    this.list.hidden = this.shownIds.length < 2;
    this.select(active && this.shownIds.includes(active) ? active : (this.shownIds[0] ?? null), false);
  }

  private pick(id: TabId, focus: boolean): void {
    this.select(id, focus);
    this.onPick(id);
  }

  private select(id: TabId | null, focus: boolean): void {
    this.current = id;
    for (const [tid, t] of this.tabs) {
      const on = tid === id;
      t.tab.setAttribute('aria-selected', String(on));
      t.tab.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
    }
    if (!id) return;
    if (focus) this.tabs.get(id)?.tab.focus();
    this.onShow(id);
  }
}
