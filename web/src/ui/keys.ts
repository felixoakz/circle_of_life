// The "Keyboard" dialog (DESIGN.md §8), opened from the wordmark menu: every
// key the page answers to, in two columns. A native <dialog> like Data &
// credits (ui/credits.ts): showModal() traps focus, Esc closes it, focus
// goes back to the menu. Same surface, hairline border and flat backdrop.

type Child = Node | string;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', children: Child[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

/** [keys, what they do], in the order DESIGN.md §8 lists them. */
const KEYS: readonly [string, string][] = [
  ['/  or  ⌘K', 'Search'],
  ['Esc', 'Close search, a dialog or this menu; leave free view'],
  ['↑  or  Backspace', 'Select the parent'],
  ['↓', 'Select the largest child'],
  ['←  →', 'Select the previous or next sibling'],
  ['H', 'Back to Homo sapiens'],
  ['R', 'Auto-orient on or off'],
  ['F', 'Free view on or off'],
  ['Shift + drag', 'Turn about the pointer, in free view'],
  ['+  −', 'Zoom in or out'],
  ['↑  ↓  on the zoom strip', 'Zoom by 5%'],
  ['Page Up  Page Down', 'Zoom by 20%'],
  ['Home  End', 'All the way out or in'],
];

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>';

export class KeysDialog {
  private readonly dialog: HTMLDialogElement;

  constructor() {
    const close = el('button', 'ctl credits-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => this.dialog.close());
    const list = el('dl', 'keys-list');
    for (const [keys, what] of KEYS) {
      // The one taxon name here is set like every other (DESIGN.md §3).
      const at = what.indexOf('Homo sapiens');
      const dd =
        at < 0
          ? el('dd', '', [what])
          : el('dd', '', [what.slice(0, at), el('span', 'taxon-italic', ['Homo sapiens']), what.slice(at + 12)]);
      list.append(el('dt', '', [keys]), dd);
    }
    const title = el('h2', 'credits-title', ['Keyboard']);
    title.id = 'keys-title';
    this.dialog = el('dialog', 'credits keys', [el('div', 'credits-head', [title, close]), el('div', 'credits-body', [list])]);
    this.dialog.setAttribute('aria-labelledby', 'keys-title');
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    document.body.append(this.dialog);
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
  }
}
