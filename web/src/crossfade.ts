// Reduced motion replaces flights with a cut plus a 120 ms crossfade
// (DESIGN.md §6). Just before the cut, the canvases still show the old view:
// they are copied into one snapshot canvas laid over them, which then fades
// out over the new view. The tree canvas must be copied in the same task
// that drew it (its drawing buffer is not preserved), so the scene renders
// the old view once more right before calling `snapshot`.

export const CROSSFADE_MS = 120;

/** Lays a fading copy of `canvases` (stacked in order) over the last of them. */
export function crossfade(canvases: readonly HTMLCanvasElement[], ms = CROSSFADE_MS): void {
  const top = canvases[canvases.length - 1];
  if (!top) return;
  const snap = document.createElement('canvas');
  snap.className = 'stage crossfade';
  snap.setAttribute('aria-hidden', 'true');
  snap.width = top.width;
  snap.height = top.height;
  const ctx = snap.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, snap.width, snap.height);
  for (const c of canvases) ctx.drawImage(c, 0, 0, snap.width, snap.height);
  top.after(snap);
  // Two frames: the first paints the snapshot opaque, the second starts the fade.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      snap.style.transition = `opacity ${ms}ms linear`;
      snap.style.opacity = '0';
    }),
  );
  const done = (): void => snap.remove();
  snap.addEventListener('transitionend', done, { once: true });
  window.setTimeout(done, ms + 200);
}
