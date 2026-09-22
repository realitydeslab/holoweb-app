// Headless Chromium smoke test: loads both examples against mock-native (mono and stereo),
// enters AR through ARButton, taps to place, and asserts an XR frame loop with hit-test results,
// the expected view count and renderer backend, visible reticle pixels, and no console errors.
// three.js is served from node_modules in place of the jsDelivr URLs in the importmap.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runStaleEyeChecks as staleEyeChecks } from './e2e-stale-eye.mjs';

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
  // native toggle mid-session (Start AR in mono, then the top-right button): session keeps running,
  // the view count follows the mode after every switch
  { page: 'three-ar.html', mode: 'mono', toggle: ['stereo', 'mono', 'stereo'], backend: 'webgl', views: 2 },
  { page: 'three-ar-webgpu.html', mode: 'mono', toggle: ['stereo', 'mono', 'stereo'], backend: 'webgpu', views: 2 },
  // eye rects change size under an existing layer (late device info): presenter's scaling blit
  { page: 'three-ar-webgpu.html', mode: 'stereo', lateModel: 'iPhone14,2', backend: 'webgpu', views: 2, path: 'blit' },
  // rotation to portrait mid-session: fixed-size targets, presentation rescales (reticle must stay centred)
  { page: 'three-ar.html', mode: 'mono', rotate: true, backend: 'webgl', views: 1 },
  { page: 'three-ar-webgpu.html', mode: 'mono', rotate: true, backend: 'webgpu', views: 1, path: 'blit' },
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

  const label = `${c.page} [${[c.mode, ...(c.toggle ?? [])].join(' -> ')}${c.lateModel ? `, late model ${c.lateModel}` : ''}${c.rotate ? ', rotate' : ''}]`;
  try {
    await page.goto(`${base}/examples/${c.page}?holoweb-mode=${c.mode}`);
    const gpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    await page.locator('#ARButton', { hasText: 'START AR' }).click({ timeout: 10000 });
    await page.waitForFunction(() => window.__arStatus.hitFrames > 10, null, { timeout: 10000 });
    if (c.toggle) {
      const phases = [];
      let seenStereo = false;
      for (const mode of ['mono', ...c.toggle]) {
        if (mode !== 'mono' || phases.length) await page.evaluate((m) => window.__holoweb.setMode(m), mode);
        const at = await page.evaluate(() => window.__arStatus.xrFrames);
        await page.waitForFunction((n) => window.__arStatus.xrFrames > n + 20, at, { timeout: 5000 });
        const { views, activeViews } = await page.evaluate(() => window.__arStatus);
        seenStereo ||= mode === 'stereo';
        phases.push(`${mode}:${views}/${activeViews}`);
        // the view count never drops within a session: mono after stereo keeps an inert 0x0 2nd view
        if (views !== (seenStereo ? 2 : 1)) problems.push(`after switching to ${mode}: ${views} views`);
        if (activeViews !== (mode === 'stereo' ? 2 : 1)) problems.push(`after switching to ${mode}: ${activeViews} active views`);
      }
      const active = await page.evaluate(() => Boolean(window.__holoweb.bridge.latest) && document.documentElement.classList.contains('holoweb-immersive'));
      if (!active) problems.push('session did not survive the toggles');
      console.log(`    phases ${phases.join(' ')}`);
    }
    if (c.rotate) {
      await page.setViewportSize({ width: 390, height: 844 });
      const at = await page.evaluate(() => window.__arStatus.xrFrames);
      await page.waitForFunction((n) => window.__arStatus.xrFrames > n + 20, at, { timeout: 5000 });
      const changes = await page.evaluate(() => window.__holoweb.bridge.layoutChanges);
      if (changes < 1) problems.push('rotation not seen by the bridge');
    }
    if (c.lateModel) {
      await page.evaluate((m) => (window.__holoweb.bridge.deviceInfo.model = m), c.lateModel);
      const at = await page.evaluate(() => window.__arStatus.xrFrames);
      await page.waitForFunction((n) => window.__arStatus.xrFrames > n + 10, at, { timeout: 5000 });
    }
    await page.mouse.click(422, 200);
    await page.waitForFunction(() => window.__arStatus.placed > 0, null, { timeout: 5000 });
    // the anchor becomes tracked on the XR frame after createAnchor resolves
    await page.waitForFunction(() => window.__arStatus.anchors > 0, null, { timeout: 5000 }).catch(() => undefined);
    await page.waitForFunction(() => window.__arStatus.xrFrames > 60, null, { timeout: 5000 });
    const status = await page.evaluate(() => window.__arStatus);
    const path = await page.evaluate(() => document.querySelector('[data-holoweb=xr-gpu-presenter]')?.dataset.path ?? 'none');
    if (c.path && path !== c.path) problems.push(`presenter path ${path}, expected ${c.path}`);
    const png = await page.screenshot();
    const shot = `${c.page.replace('.html', '')}-${c.mode}${c.toggle ? '-toggled' : ''}${c.lateModel ? '-late-model' : ''}${c.rotate ? '-rotated' : ''}.png`;
    await writeFile(join(shotDir, shot), png);
    const reticle = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = new OffscreenCanvas(img.width, img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0, sx = 0, sy = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 120 && d[i + 1] > 170 && d[i + 2] > 200) {
          n++;
          sx += (i / 4) % img.width;
          sy += Math.floor(i / 4 / img.width);
        }
      }
      return { n, cx: n ? sx / n / img.width : 0, cy: n ? sy / n / img.height : 0 };
    }, png.toString('base64'));
    const reticlePixels = reticle.n;

    const expectBackend = c.backend === 'webgpu' && !gpu ? 'webgl' : c.backend;
    if (status.backend !== expectBackend) problems.push(`backend ${status.backend}, expected ${expectBackend}`);
    if (status.views !== c.views) problems.push(`views ${status.views}, expected ${c.views}`);
    if (!c.toggle && status.activeViews !== c.views) problems.push(`activeViews ${status.activeViews}, expected ${c.views}`);
    if (status.xrFrames < 30) problems.push(`only ${status.xrFrames} XR frames`);
    if (reticlePixels < 50) problems.push(`reticle not visible (${reticlePixels} px)`);
    if (c.rotate && (Math.abs(reticle.cx - 0.5) > 0.12 || Math.abs(reticle.cy - 0.5) > 0.12)) {
      problems.push(`reticle off-centre after rotation (${reticle.cx.toFixed(2)}, ${reticle.cy.toFixed(2)})`);
    }
    if (status.anchors < 1) problems.push('no tracked anchor after placing');
    if (!status.light || !(status.light.sh0 > 0)) problems.push('no light estimate');
    if (c.backend === 'webgpu' && !status.sessionFeatures.includes('webgpu')) problems.push('webgpu feature missing');
    problems.push(...status.errors.map((e) => `page error: ${e}`));
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'} ${label}: backend=${status.backend} gpuAdapter=${gpu} views=${status.views} ` +
        `xrFrames=${status.xrFrames} hitFrames=${status.hitFrames} placed=${status.placed} anchors=${status.anchors} ` +
        `light=${JSON.stringify(status.light)} reticlePx=${reticlePixels} presenter=${path}`,
    );
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log(`FAIL ${label}`);
  }
  for (const p of problems) console.log(`    ${p}`);
  if (problems.length) failures++;
  await context.close();
}

// examples/demo.html (the device showcase, WebGPURenderer): autostart in mono, then toggle like the
// native button. Frames and view counts are sampled through the page's own XR session.
{
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    if (m.type() === 'warning' && /WebGL|GL_|WebGPU|GPU/.test(m.text())) problems.push(`gpu warning: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route(CDN, async (route) => {
    const file = route.request().url().match(CDN)[1];
    await route.fulfill({ body: await readFile(join(root, 'node_modules/three', file)), contentType: 'text/javascript' });
  });
  const sample = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const session = window.__holoweb.bridge.device.activeSession;
          if (!session) return resolve({ frames: 0, views: 0 });
          let frames = 0;
          let views = 0;
          session.requestReferenceSpace('local').then((local) => {
            const tick = (_t, frame) => {
              frames++;
              views = frame.getViewerPose(local)?.views.length ?? 0;
              if (frames < 20) session.requestAnimationFrame(tick);
              else resolve({ frames, views });
            };
            session.requestAnimationFrame(tick);
          });
        }),
    );
  const phases = [];
  try {
    await page.goto(`${base}/examples/demo.html?autostart`);
    await page.waitForFunction(() => Boolean(window.__holoweb?.bridge.device.activeSession), null, { timeout: 10000 });
    let seenStereo = false;
    for (const mode of ['mono', 'stereo', 'mono', 'stereo']) {
      if (phases.length) await page.evaluate((m) => window.__holoweb.setMode(m), mode);
      const { frames, views } = await sample();
      seenStereo ||= mode === 'stereo';
      phases.push(`${mode}:${views}`);
      if (frames < 20) problems.push(`${mode}: XR loop stalled (${frames} frames)`);
      if (views !== (seenStereo ? 2 : 1)) problems.push(`${mode}: ${views} views`);
    }
    const presenter = await page.evaluate(() => document.querySelector('[data-holoweb=xr-gpu-presenter]')?.dataset.path ?? 'none');
    if (presenter === 'none') problems.push('WebGPU presenter never ran');
    await writeFile(join(shotDir, 'demo-toggled.png'), await page.screenshot());
    console.log(`${problems.length ? 'FAIL' : 'PASS'} demo.html [autostart mono -> stereo -> mono -> stereo]: phases ${phases.join(' ')} presenter=${presenter}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL demo.html');
  }
  for (const p of problems) console.log(`    ${p}`);
  if (problems.length) failures++;
  cases.push({ page: 'demo.html' });
  await context.close();
}

{
  const r = await staleEyeChecks({ browser, base, root, shotDir });
  failures += r.failures;
  for (let i = 0; i < r.cases; i++) cases.push({ page: 'stale-eye' });
}

await browser.close();
server.close();
console.log(`${cases.length - failures}/${cases.length} e2e cases passed; screenshots in ${shotDir}`);
process.exit(failures ? 1 : 0);
