// Headless run of the `?debug=parity` compute check (gpu/parity.ts): opens
// the app with the WebGPU flags from docs/webgpu.md, waits for
// `window.__gpuParity`, prints a table, exits 1 unless every check passes.
// Needs a fresh build and a running server, as for scripts/shot.ts:
//
//   pnpm -C web parity
//   SHOT_BASE=http://localhost:3078 pnpm -C web parity

import { chromium } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:3000';
/** docs/webgpu.md "Chosen headless flags" (also scripts/shot.ts WEBGPU_ARGS). */
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'];

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: WEBGPU_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`  [page] page error: ${e.message}`));
    await page.goto(`${BASE}/?debug=parity&renderer=webgpu`);
    await page.waitForFunction(() => window.__gpuParity !== undefined, null, { timeout: 120_000 });
    const p = await page.evaluate(() => window.__gpuParity);
    const renderer = await page.evaluate(() => window.__renderer);
    const errors = await page.evaluate(() => window.__gpuErrors ?? 0);
    if (!p) throw new Error('no __gpuParity');
    console.log(`gpu parity on ${p.adapter} (tree drawn by ${renderer})`);
    if (p.error) console.log(`  error: ${p.error}`);
    for (const r of p.results) {
      const err = `${r.maxErr.toExponential(2)} ≤ ${r.tol.toExponential(2)} ${r.unit}`;
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(36)} n=${String(r.count).padStart(4)}  ${err}`);
      if (!r.ok && r.worst) console.log(`       worst: ${r.worst}`);
      if (r.note) console.log(`       ${r.note}`);
    }
    if (errors > 0) console.log(`  ${errors} WebGPU errors`);
    if (!p.ok || errors > 0) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
