// Stale right eye after stereo -> mono, for engines that keep a fixed stereo camera array.
// 1. examples/fixtures/old-three-r111.html (three.js r111 WebGLRenderer + old WebXR API):
//    green backdrop only for cameraL/mono, red only for cameraR. Checks: mono has no red; stereo has
//    red in the right half (sanity); mono after stereo has no red, and the stereo right-eye viewport
//    rect is never passed to gl.viewport again.
// 2. HOLOWEB_E2E_TOJI=1: https://toji.github.io/webxr-particles/ (three r111dev, network needed),
//    polyfill injected at document start like the app does; same gl.viewport check.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROUTES = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.0\/(.*)$/, 'node_modules/three'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.111\.0\/(.*)$/, 'node_modules/three-r111'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.152\.2\/(.*)$/, 'node_modules/three-r152'],
];

async function newPage(browser, root, problems) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  for (const [pattern, dir] of ROUTES) {
    await page.route(pattern, async (route) => {
      const file = route.request().url().match(pattern)[1];
      await route.fulfill({ body: await readFile(join(root, dir, file)), contentType: 'text/javascript' });
    });
  }
  // Record gl.viewport rects while window.__vpOn is set.
  await page.addInitScript(() => {
    window.__vp = new Set();
    for (const C of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
      if (!C) continue;
      const viewport = C.prototype.viewport;
      C.prototype.viewport = function (x, y, w, h) {
        if (window.__vpOn) window.__vp.add(`${x},${y},${w},${h}`);
        return viewport.call(this, x, y, w, h);
      };
    }
  });
  return { context, page };
}

/** Red / green pixel counts per screen half from a screenshot. */
async function colours(page) {
  const png = await page.screenshot();
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = new OffscreenCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const out = { redLeft: 0, redRight: 0, greenLeft: 0, greenRight: 0 };
    for (let i = 0; i < d.length; i += 4) {
      const right = (i / 4) % img.width >= img.width / 2;
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) out[right ? 'redRight' : 'redLeft']++;
      if (d[i + 1] > 200 && d[i] < 60 && d[i + 2] < 60) out[right ? 'greenRight' : 'greenLeft']++;
    }
    return out;
  }, png.toString('base64'));
  return { png, stats };
}

/** Wait until the polyfill's session has produced `n` more XR frames. */
const frames = (page, n) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const session = window.__holoweb.bridge.device.activeSession;
        let k = 0;
        const tick = () => (++k >= n ? resolve() : session.requestAnimationFrame(tick));
        session.requestAnimationFrame(tick);
      }),
    n,
  );

/** Enter stereo, capture the right-eye GL viewport, return to mono, check it is never used again. */
async function staleViewportCheck(page, problems) {
  await page.evaluate(() => window.__holoweb.setMode('stereo'));
  await frames(page, 10);
  const right = await page.evaluate(() => {
    const r = window.__holoweb.bridge.device.nativeViewports.right;
    return r ? `${r.x},${r.y},${r.width},${r.height}` : '';
  });
  await page.evaluate(() => { window.__vp.clear(); window.__vpOn = true; });
  await frames(page, 10);
  const usedInStereo = await page.evaluate((r) => window.__vp.has(r), right);
  await page.evaluate(() => window.__holoweb.setMode('mono'));
  await frames(page, 3); // first mono frames
  await page.evaluate(() => window.__vp.clear());
  await frames(page, 20);
  const usedInMono = await page.evaluate((r) => window.__vp.has(r), right);
  await page.evaluate(() => (window.__vpOn = false));
  if (!usedInStereo) problems.push(`right-eye viewport ${right} not used in stereo (check is blind)`);
  if (usedInMono) problems.push(`stale right eye: gl.viewport(${right}) still called in mono`);
  return { right, usedInStereo, usedInMono };
}

async function fixtureCase({ browser, base, root, shotDir }) {
  const problems = [];
  const { context, page } = await newPage(browser, root, problems);
  const phases = [];
  try {
    await page.goto(`${base}/examples/fixtures/old-three-r111.html`);
    await page.click('#start');
    await page.waitForFunction(() => window.__fixture.xrFrames > 20, null, { timeout: 10000 });
    const revision = await page.evaluate(() => window.__fixture.revision);
    const mono1 = (await colours(page)).stats;
    phases.push(`mono red=${mono1.redLeft + mono1.redRight} green=${mono1.greenLeft + mono1.greenRight}`);
    if (mono1.redLeft + mono1.redRight > 0 || mono1.greenLeft + mono1.greenRight === 0) problems.push('mono before stereo: wrong content');

    await page.evaluate(() => window.__holoweb.setMode('stereo'));
    await frames(page, 20);
    const stereo = (await colours(page)).stats;
    phases.push(`stereo redRight=${stereo.redRight} greenLeft=${stereo.greenLeft}`);
    if (stereo.redRight === 0 || stereo.greenLeft === 0) problems.push('stereo: right eye not rendered (check is blind)');

    await page.evaluate(() => window.__holoweb.setMode('mono'));
    await frames(page, 20);
    const { png, stats: mono2 } = await colours(page);
    await writeFile(join(shotDir, 'old-three-r111-stereo-to-mono.png'), png);
    phases.push(`mono red=${mono2.redLeft + mono2.redRight} green=${mono2.greenLeft + mono2.greenRight}`);
    if (mono2.redLeft + mono2.redRight > 0) problems.push(`stale right eye after stereo -> mono: ${mono2.redRight + mono2.redLeft} red px`);
    if (mono2.greenRight === 0) problems.push('mono after stereo: right half not covered by the mono view');

    const vp = await staleViewportCheck(page, problems);
    phases.push(`gl.viewport(${vp.right}) stereo=${vp.usedInStereo} mono=${vp.usedInMono}`);
    problems.push(...(await page.evaluate(() => window.__fixture.errors)).map((e) => `page error: ${e}`));
    console.log(`${problems.length ? 'FAIL' : 'PASS'} fixtures/old-three-r111.html (three r${revision}) [mono -> stereo -> mono]: ${phases.join('; ')}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL fixtures/old-three-r111.html');
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

async function tojiCase({ browser, root, shotDir }) {
  const problems = [];
  const pageErrors = [];
  const { context, page } = await newPage(browser, root, pageErrors);
  try {
    await page.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
    await page.goto('https://toji.github.io/webxr-particles/', { waitUntil: 'load', timeout: 30000 });
    await page.getByRole('button', { name: /AR/ }).first().click({ timeout: 10000 });
    await page.waitForFunction(() => Boolean(window.__holoweb?.bridge.device.activeSession), null, { timeout: 10000 });
    await frames(page, 20);
    const vp = await staleViewportCheck(page, problems);
    await writeFile(join(shotDir, 'toji-webxr-particles-stereo-to-mono.png'), await page.screenshot());
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'} toji.github.io/webxr-particles (three r111dev) [mono -> stereo -> mono]: ` +
        `gl.viewport(${vp.right}) stereo=${vp.usedInStereo} mono=${vp.usedInMono}; page console errors: ${pageErrors.length}`,
    );
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL toji.github.io/webxr-particles');
  }
  for (const p of problems) console.log(`    ${p}`);
  for (const p of pageErrors.slice(0, 3)) console.log(`    (page, informational) ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

/** G1: three r152 WebGLRenderer must get renderState.layers === undefined and use XRWebGLLayer. */
async function r152Case({ browser, base, root, shotDir }) {
  const problems = [];
  const { context, page } = await newPage(browser, root, problems);
  try {
    await page.goto(`${base}/examples/fixtures/three-r152.html`);
    await page.locator('#ARButton', { hasText: 'START AR' }).click({ timeout: 10000 });
    await page.waitForFunction(() => window.__fixture.xrFrames > 30, null, { timeout: 10000 });
    const status = await page.evaluate(() => window.__fixture);
    const { png, stats } = await colours(page);
    await writeFile(join(shotDir, 'three-r152.png'), png);
    const magenta = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = new OffscreenCanvas(img.width, img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200) n++;
      return n;
    }, png.toString('base64'));
    void stats;
    if (status.layersAtStart !== 'undefined') problems.push(`renderState.layers at session start = ${status.layersAtStart}`);
    if (magenta < 500) problems.push(`cube not rendered (${magenta} px)`);
    problems.push(...status.errors.map((e) => `page error: ${e}`));
    console.log(`${problems.length ? 'FAIL' : 'PASS'} fixtures/three-r152.html (three r${status.revision} WebGLRenderer) [G1 layers path]: renderState.layers=${status.layersAtStart}, xrFrames=${status.xrFrames}, cube px=${magenta}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL fixtures/three-r152.html');
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

export async function runStaleEyeChecks(env) {
  let failures = (await fixtureCase(env)) + (await r152Case(env));
  let cases = 2;
  if (process.env.HOLOWEB_E2E_TOJI) {
    failures += await tojiCase(env);
    cases++;
  }
  return { failures, cases };
}
