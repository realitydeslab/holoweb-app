// Headless Chromium smoke test: loads both examples against mock-native (mono and stereo),
// enters AR through ARButton, taps to place, and asserts an XR frame loop with hit-test results,
// the expected view count and renderer backend, visible reticle pixels, and no console errors.
// three.js is served from node_modules in place of the jsDelivr URLs in the importmap.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.env.HOLOWEB_E2E_SHOTS ?? join(root, 'test-results');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.0\/(.*)$/;

const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(root)) throw new Error('outside root');
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});

const cases = [
  { page: 'three-ar.html', mode: 'mono', backend: 'webgl', views: 1 },
  { page: 'three-ar.html', mode: 'stereo', backend: 'webgl', views: 2 },
  { page: 'three-ar-webgpu.html', mode: 'mono', backend: 'webgpu', views: 1, path: 'copy' },
  { page: 'three-ar-webgpu.html', mode: 'stereo', backend: 'webgpu', views: 2, path: 'copy' },
  { page: 'three-ar.html', mode: 'mono', switchTo: 'stereo', backend: 'webgl', views: 2 },
  { page: 'three-ar.html', mode: 'stereo', switchTo: 'mono', backend: 'webgl', views: 1 },
  // WebGPU sessions end on a view-count change; the page enters again in stereo
  { page: 'three-ar-webgpu.html', mode: 'mono', switchTo: 'stereo', reenter: true, backend: 'webgpu', views: 2 },
  // eye rects change size under an existing layer (late device info): presenter's scaling blit
  { page: 'three-ar-webgpu.html', mode: 'stereo', lateModel: 'iPhone14,2', backend: 'webgpu', views: 2, path: 'blit' },
];

let failures = 0;
await mkdir(shotDir, { recursive: true });
for (const c of cases) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    // WebGL / WebGPU validation errors are reported as warnings
    if (m.type() === 'warning' && /WebGL|GL_|WebGPU|GPU/.test(m.text()) && !m.text().startsWith('HoloWeb:')) {
      problems.push(`gpu warning: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route(CDN, async (route) => {
    const file = route.request().url().match(CDN)[1];
    const body = await readFile(join(root, 'node_modules/three', file));
    await route.fulfill({ body, contentType: 'text/javascript' });
  });

  const label = `${c.page} [${c.mode}${c.switchTo ? ` -> ${c.switchTo}` : ''}${c.reenter ? ', re-enter' : ''}${c.lateModel ? `, late model ${c.lateModel}` : ''}]`;
  try {
    await page.goto(`${base}/examples/${c.page}?holoweb-mode=${c.mode}`);
    const gpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    await page.locator('#ARButton', { hasText: 'START AR' }).click({ timeout: 10000 });
    await page.waitForFunction(() => window.__arStatus.hitFrames > 10, null, { timeout: 10000 });
    if (c.switchTo) {
      await page.evaluate((m) => window.__holoweb.setMode(m), c.switchTo);
      if (c.reenter) {
        await page.locator('#ARButton', { hasText: 'START AR' }).click({ timeout: 5000 });
        await page.waitForFunction(() => window.__arStatus.hitFrames > 80, null, { timeout: 10000 });
      }
      const at = await page.evaluate(() => window.__arStatus.xrFrames);
      await page.waitForFunction((n) => window.__arStatus.xrFrames > n + 10, at, { timeout: 5000 });
    }
    if (c.lateModel) {
      await page.evaluate((m) => (window.__holoweb.bridge.deviceInfo.model = m), c.lateModel);
      const at = await page.evaluate(() => window.__arStatus.xrFrames);
      await page.waitForFunction((n) => window.__arStatus.xrFrames > n + 10, at, { timeout: 5000 });
    }
    await page.mouse.click(422, 200);
    await page.waitForFunction(() => window.__arStatus.placed > 0, null, { timeout: 5000 });
    await page.waitForFunction(() => window.__arStatus.xrFrames > 60, null, { timeout: 5000 });
    const status = await page.evaluate(() => window.__arStatus);
    const path = await page.evaluate(() => document.querySelector('[data-holoweb=xr-gpu-presenter]')?.dataset.path ?? 'none');
    if (c.path && path !== c.path) problems.push(`presenter path ${path}, expected ${c.path}`);
    const png = await page.screenshot();
    const shot = `${c.page.replace('.html', '')}-${c.mode}${c.switchTo ? `-to-${c.switchTo}` : ''}${c.lateModel ? '-late-model' : ''}.png`;
    await writeFile(join(shotDir, shot), png);
    const reticlePixels = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = new OffscreenCanvas(img.width, img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] > 170 && d[i + 2] > 200) n++;
      return n;
    }, png.toString('base64'));

    const expectBackend = c.backend === 'webgpu' && !gpu ? 'webgl' : c.backend;
    if (status.backend !== expectBackend) problems.push(`backend ${status.backend}, expected ${expectBackend}`);
    if (status.views !== c.views) problems.push(`views ${status.views}, expected ${c.views}`);
    if (status.xrFrames < 30) problems.push(`only ${status.xrFrames} XR frames`);
    if (reticlePixels < 50) problems.push(`reticle not visible (${reticlePixels} px)`);
    if (c.backend === 'webgpu' && !status.sessionFeatures.includes('webgpu')) problems.push('webgpu feature missing');
    problems.push(...status.errors.map((e) => `page error: ${e}`));
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'} ${label}: backend=${status.backend} gpuAdapter=${gpu} views=${status.views} ` +
        `xrFrames=${status.xrFrames} hitFrames=${status.hitFrames} placed=${status.placed} reticlePx=${reticlePixels} presenter=${path}`,
    );
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log(`FAIL ${label}`);
  }
  for (const p of problems) console.log(`    ${p}`);
  if (problems.length) failures++;
  await context.close();
}

await browser.close();
server.close();
console.log(`${cases.length - failures}/${cases.length} e2e cases passed; screenshots in ${shotDir}`);
process.exit(failures ? 1 : 0);
