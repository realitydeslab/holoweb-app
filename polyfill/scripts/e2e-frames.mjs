// Frame / engine integration:
// 1. examples/fixtures/iframe-host.html: three-ar.html inside a same-origin iframe (playcanv.as shape).
//    AR is entered from the iframe; only the iframe posts `ready` (frame: 'sub'), the main frame none.
// 2. A-Frame 1.8 model-viewer (network, skipped offline): xr-mode-ui XRMode: xr calls
//    navigator.xr.offerSession at load. With offerSession removed there must be no
//    "Failed to enter VR mode" error, and the AR button must enter a running session.
// 3. modelviewer.dev augmented-reality examples (network, skipped offline): the default AR button in a
//    <model-viewer> shadow root enters WebXR AR and model-viewer places the model (device bug: its
//    XRRay({x,y,z}) direction without `w` threw; XRRayDirectionInit defaults w to 0).
// 4. SuperSplat viewer (network, skipped offline): button.sse-arMode stays `disabled` until the splat has
//    loaded (a click before that is a silent no-op: the device "no requestSession" report). After it is
//    enabled, a plain element.click() (like native's test click) must reach requestSession and start AR.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.0\/(.*)$/;
const AFRAME = 'https://aframe.io/aframe/examples/showcase/model-viewer/';
const MODEL_VIEWER = 'https://modelviewer.dev/examples/augmentedreality/';
const SUPERSPLAT = 'https://superspl.at/s?id=5c0f892e&webgl';

async function newPage(browser, root, problems, { strictConsole = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (strictConsole || /Failed to enter|HoloWeb|holoweb/i.test(m.text())) problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route(CDN, async (route) => {
    const file = route.request().url().match(CDN)[1];
    await route.fulfill({ body: await readFile(join(root, 'node_modules/three', file)), contentType: 'text/javascript' });
  });
  return { context, page };
}

/** Count XR frames (and views) through the given frame's own active session. */
const sampleXR = (frame, n = 20) =>
  frame.evaluate(
    (n) =>
      new Promise((resolve) => {
        const session = window.__holoweb.bridge.device.activeSession;
        if (!session) return resolve({ frames: 0, views: 0 });
        session.requestReferenceSpace('local').then((local) => {
          let frames = 0;
          let views = 0;
          const tick = (_t, f) => {
            frames++;
            views = f.getViewerPose(local)?.views.length ?? 0;
            if (frames < n) session.requestAnimationFrame(tick);
            else resolve({ frames, views });
          };
          session.requestAnimationFrame(tick);
        });
      }),
    n,
  );

async function iframeCase({ browser, base, root, shotDir }) {
  const problems = [];
  const { context, page } = await newPage(browser, root, problems);
  try {
    await page.goto(`${base}/examples/fixtures/iframe-host.html`);
    const app = page.frameLocator('iframe');
    await app.locator('#ARButton', { hasText: 'START AR' }).click({ timeout: 10000 });
    const child = page.frames().find((f) => f !== page.mainFrame());
    await child.waitForFunction(() => window.__arStatus.hitFrames > 10, null, { timeout: 10000 });
    const xr = await sampleXR(child);
    const main = await page.evaluate(() => ({ readyPosts: window.__holoweb.bridge.readyPosts, session: Boolean(window.__holoweb.bridge.device.activeSession) }));
    const sub = await child.evaluate(() => ({ readyPosts: window.__holoweb.bridge.readyPosts, frame: window.__holoweb.bridge.frame }));
    if (main.readyPosts !== 0 || main.session) problems.push(`main frame posted ready ${main.readyPosts}x / has session ${main.session}`);
    if (sub.readyPosts !== 1 || sub.frame !== 'sub') problems.push(`iframe ready ${sub.readyPosts}x as ${sub.frame}`);
    if (xr.frames < 20 || xr.views !== 1) problems.push(`iframe XR loop: ${JSON.stringify(xr)}`);
    await writeFile(join(shotDir, 'iframe-host.png'), await page.screenshot());
    console.log(`${problems.length ? 'FAIL' : 'PASS'} fixtures/iframe-host.html [AR from same-origin iframe]: main ready=${main.readyPosts}, iframe ready=${sub.readyPosts} (${sub.frame}), iframe XR frames=${xr.frames} views=${xr.views}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL fixtures/iframe-host.html');
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

async function aframeCase({ browser, root, shotDir }) {
  const problems = [];
  // A-Frame's page loads third-party assets; only errors about entering XR or HoloWeb count.
  const { context, page } = await newPage(browser, root, problems, { strictConsole: false });
  try {
    await page.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
    try {
      await page.goto(AFRAME, { waitUntil: 'load', timeout: 30000 });
    } catch (err) {
      console.log(`SKIP A-Frame model-viewer (network): ${String(err.message).split('\n')[0]}`);
      await context.close();
      return 0;
    }
    await page.waitForFunction(() => document.querySelector('a-scene')?.hasLoaded === true, null, { timeout: 30000 });
    await page.waitForTimeout(1000); // xr-mode-ui runs enterVR(false, true) -> offerSession at load
    const offer = await page.evaluate(() => 'offerSession' in navigator.xr);
    await page.locator('.a-enter-ar-button').click({ timeout: 10000 });
    await page.waitForFunction(() => Boolean(window.__holoweb.bridge.device.activeSession), null, { timeout: 10000 });
    const xr = await sampleXR(page.mainFrame());
    // a tap exercises A-Frame's ar-hit-test (requestHitTestSourceForTransientInput)
    await page.mouse.click(422, 250);
    await sampleXR(page.mainFrame(), 10);
    const inAR = await page.evaluate(() => document.querySelector('a-scene').is('ar-mode'));
    if (offer) problems.push('navigator.xr.offerSession is still exposed');
    if (xr.frames < 20) problems.push(`XR loop: ${JSON.stringify(xr)}`);
    if (!inAR) problems.push('a-scene is not in ar-mode');
    await writeFile(join(shotDir, 'aframe-model-viewer.png'), await page.screenshot());
    console.log(`${problems.length ? 'FAIL' : 'PASS'} aframe.io model-viewer (A-Frame 1.8, live) [AR button]: offerSession exposed=${offer}, ar-mode=${inAR}, XR frames=${xr.frames} views=${xr.views}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL aframe.io model-viewer');
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

async function modelViewerCase({ browser, root, shotDir }) {
  const problems = [];
  const { context, page } = await newPage(browser, root, problems, { strictConsole: false });
  page.on('console', (m) => m.type() === 'error' && /XRRay|XRSession|WebXR/.test(m.text()) && problems.push(`console.error: ${m.text().slice(0, 200)}`));
  const label = 'modelviewer.dev augmentedreality (live) [default AR button in shadow root]';
  try {
    await page.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
    try {
      await page.goto(MODEL_VIEWER, { waitUntil: 'load', timeout: 45000 });
    } catch (err) {
      console.log(`SKIP ${label} (network): ${String(err.message).split('\n')[0]}`);
      await context.close();
      return 0;
    }
    // the first example slots its own button; the next one shows model-viewer's default #default-ar-button
    const viewer = page.locator('model-viewer[ar]').nth(1);
    await viewer.scrollIntoViewIfNeeded();
    await viewer.locator('#default-ar-button').click({ timeout: 20000 });
    await page.waitForFunction(() => Boolean(window.__holoweb.bridge.device.activeSession), null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('model-viewer[ar]')[1].getAttribute('ar-status') === 'object-placed', null, { timeout: 10000 });
    const xr = await sampleXR(page.mainFrame());
    if (xr.frames < 20) problems.push(`XR loop: ${JSON.stringify(xr)}`);
    await writeFile(join(shotDir, 'model-viewer-ar.png'), await page.screenshot());
    console.log(`${problems.length ? 'FAIL' : 'PASS'} ${label}: ar-status=object-placed, XR frames=${xr.frames} views=${xr.views}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log(`FAIL ${label}`);
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

/** Record navigator.xr calls and their outcome (after the bundle installs navigator.xr). */
function recordXRCalls() {
  window.__xrCalls = [];
  const xr = navigator.xr;
  for (const m of ['isSessionSupported', 'requestSession']) {
    const f = xr[m];
    xr[m] = function (...args) {
      const entry = { m, mode: args[0], init: args[1] ? JSON.stringify(args[1], (k, v) => (v instanceof Element ? `<${v.tagName}>` : v)) : undefined };
      window.__xrCalls.push(entry);
      const p = f.apply(this, args);
      p.then(() => (entry.ok = true), (e) => (entry.error = `${e.name}: ${e.message}`));
      return p;
    };
  }
}

async function superSplatCase({ browser, root, shotDir }) {
  const problems = [];
  const { context, page } = await newPage(browser, root, problems, { strictConsole: false });
  page.on('console', (m) => m.type() === 'error' && /XR|session|HoloWeb/i.test(m.text()) && problems.push(`console.error: ${m.text().slice(0, 200)}`));
  const label = 'superspl.at viewer (live) [button.sse-arMode via element.click() once enabled]';
  try {
    await page.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
    await page.addInitScript(recordXRCalls);
    try {
      await page.goto(SUPERSPLAT, { waitUntil: 'load', timeout: 45000 });
    } catch (err) {
      console.log(`SKIP ${label} (network): ${String(err.message).split('\n')[0]}`);
      await context.close();
      return 0;
    }
    await page.waitForFunction(() => document.querySelector('button.sse-arMode')?.disabled === false, null, { timeout: 60000 });
    await page.evaluate(() => document.querySelector('button.sse-arMode').click());
    await page.waitForFunction(() => Boolean(window.__holoweb.bridge.device.activeSession), null, { timeout: 10000 }).catch(() => undefined);
    const calls = await page.evaluate(() => window.__xrCalls);
    const request = calls.find((c) => c.m === 'requestSession');
    if (!request) problems.push(`no requestSession; navigator.xr calls: ${JSON.stringify(calls)}`);
    else if (!request.ok) problems.push(`requestSession ${request.error ?? 'pending'}: ${request.init}`);
    const xr = await sampleXR(page.mainFrame());
    if (xr.frames < 20) problems.push(`XR loop: ${JSON.stringify(xr)}`);
    await writeFile(join(shotDir, 'supersplat-ar.png'), await page.screenshot());
    console.log(`${problems.length ? 'FAIL' : 'PASS'} ${label}: requestSession(${request?.mode}, ${request?.init}) ok=${Boolean(request?.ok)}, XR frames=${xr.frames}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log(`FAIL ${label}`);
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

export async function runFrameChecks(env) {
  const failures = (await iframeCase(env)) + (await aframeCase(env)) + (await modelViewerCase(env)) + (await superSplatCase(env));
  return { failures, cases: 4 };
}
