// A pause that an AbortSignal can cut short. The card waits ABOUT_SETTLE_MS
// on a selection before it asks for /about (ui/panel.ts), so walking the
// tree with the arrow keys or clicking on quickly costs the upstream
// services nothing for the nodes passed over.

/** Resolves true after `ms`, or false as soon as `signal` aborts (at once if it already has). */
export function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
