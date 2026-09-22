// Image tracking e2e against the mock (setTrackedImages -> 'trackable' unless 1x1; onImages for image 0
// 0.5 m ahead, tracked / emulated alternating each second):
// - examples/image-tracking.html (three r186): scores, tracked and emulated results, gizmo drawn, ?stats
//   log; then a second session with an extra 1x1 image: scores [trackable, untrackable], the untrackable
//   image never in results, imageSpace [SameObject] across frames.
// - live PlayCanvas (app in a same-origin iframe) and Needle pages: enter AR through their own UI;
//   scores resolve, results reach the page, no page errors. Skipped when offline.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.0\/(.*)$/;
const PLAYCANVAS = 'https://playcanv.as/p/PCsSvN5h/';
// the engine.needle.tools sample page embeds this app cross-origin; HoloWeb only bridges same-origin frames
const NEEDLE = 'https://image-tracking-zubckszr0qj2.needle.run/';

function report(label, problems, detail) {
  problems.splice(0, problems.length, ...new Set(problems)); // repeated per-frame errors once
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${label}${detail ? `: ${detail}` : ''}`);
  for (const p of problems) console.log(`    ${p}`);
  return problems.length ? 1 : 0;
}

async function exampleCase({ browser, base, root, shotDir }) {
  const problems = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 200)}`);
    if (m.text().startsWith('[image-tracking] ')) logs.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route(CDN, async (route) => {
    const file = route.request().url().match(CDN)[1];
    await route.fulfill({ body: await readFile(join(root, 'node_modules/three', file)), contentType: 'text/javascript' });
  });
  const label = 'examples/image-tracking.html (three r186) + untrackable fixture';
  try {
    await page.goto(`${base}/examples/image-tracking.html?stats`);
    await page.locator('button', { hasText: 'START AR' }).click({ timeout: 10000 });
    await page.waitForFunction(() => window.__imageStatus.trackedFrames > 5 && window.__imageStatus.emulatedFrames > 5, null, { timeout: 8000 });
    await page.waitForFunction(() => window.__imageStatus.trackedFrames > 0 && window.__imageStatus.results[0]?.state === 'tracked', null, { timeout: 4000 });
    const status = await page.evaluate(() => window.__imageStatus);
    const text = await page.locator('#state').textContent();
    await writeFile(join(shotDir, 'image-tracking.png'), await page.screenshot());
    if (JSON.stringify(status.scores) !== '["trackable"]') problems.push(`scores ${JSON.stringify(status.scores)}`);
    if (status.results[0]?.width !== 0.15) problems.push(`results ${JSON.stringify(status.results)}`);
    if (!/trackable · tracked/.test(text)) problems.push(`overlay text "${text}"`);
    problems.push(...status.errors.map((e) => `page error: ${e}`));
    await page.waitForTimeout(2100);
    if (!logs.some((l) => /"scores":\["trackable"\].*"state":"(tracked|emulated)"/.test(l))) problems.push(`no [image-tracking] stats log (${logs.at(-1)})`);

    // fixture: a second session with the marker and a 1x1 image (untrackable)
    const fixture = await page.evaluate(async () => {
      await window.__holoweb.bridge.device.activeSession.end();
      const marker = await createImageBitmap(document.getElementById('marker'));
      const tiny = await createImageBitmap(new ImageData(1, 1));
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['image-tracking'],
        trackedImages: [{ image: marker, widthInMeters: 0.15 }, { image: tiny, widthInMeters: 0.05 }],
      });
      const gl = document.createElement('canvas').getContext('webgl2', { xrCompatible: true });
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      const local = await session.requestReferenceSpace('local');
      const scores = [...(await session.getTrackedImageScores())];
      const seen = new Set();
      const spaces = new Set();
      let frames = 0;
      let z = null;
      await new Promise((resolve) => {
        const tick = (_t, frame) => {
          for (const r of frame.getImageTrackingResults()) {
            seen.add(`${r.index}:${r.trackingState}`);
            spaces.add(r.imageSpace);
            z = frame.getPose(r.imageSpace, local)?.transform.position.z ?? z;
          }
          if (++frames < 150) session.requestAnimationFrame(tick);
          else resolve();
        };
        session.requestAnimationFrame(tick);
      });
      await session.end();
      return { scores, seen: [...seen].sort(), spaces: spaces.size, z, frozen: Object.isFrozen(scores) };
    });
    if (JSON.stringify(fixture.scores) !== '["trackable","untrackable"]') problems.push(`fixture scores ${JSON.stringify(fixture.scores)}`);
    if (fixture.seen.join() !== '0:emulated,0:tracked' && fixture.seen.join() !== '0:tracked') problems.push(`fixture results ${fixture.seen}`);
    if (fixture.spaces !== 1) problems.push(`imageSpace objects: ${fixture.spaces} (want 1, [SameObject])`);
    report(
      label,
      problems,
      `scores=${JSON.stringify(status.scores)} tracked=${status.trackedFrames} emulated=${status.emulatedFrames} overlay="${text}"; ` +
        `fixture scores=${JSON.stringify(fixture.scores)} results=[${fixture.seen}] imageSpaces=${fixture.spaces}`,
    );
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    report(label, problems);
  }
  await context.close();
  return problems.length ? 1 : 0;
}

/** Enter AR on a live page through its own UI, then read the polyfill's image stats in `appFrame`. */
async function liveCase({ browser, root, shotDir }, label, url, enter, appFrame) {
  const problems = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    } catch (err) {
      console.log(`SKIP ${label} (network): ${String(err.message).split('\n')[0]}`);
      await context.close();
      return 0;
    }
    await enter(page);
    let frame = await appFrame(page);
    // live apps can swallow a click that lands before they finish initialising: retry the entry once
    const started = () => frame.waitForFunction(() => Boolean(window.__holoweb?.bridge.device.activeSession), null, { timeout: 8000 }).then(() => true, () => false);
    if (!(await started())) {
      console.log(`    (${label}: no session 8 s after entering AR, retrying the entry once)`);
      await enter(page);
      frame = await appFrame(page);
    }
    const gotResults = await frame.waitForFunction(() => window.__holoweb?.images.stats.framesWithResults > 10, null, { timeout: 15000 }).then(() => true, () => false);
    if (!gotResults) {
      const why = await frame.evaluate(() => {
        const h = window.__holoweb;
        const session = h?.bridge.device.activeSession;
        return { stats: h?.images.stats, session: Boolean(session), features: session ? [...session.enabledFeatures] : null, visibility: session?.visibilityState, nativeFrames: h?.bridge.latest?.t ?? null };
      }).catch((e) => String(e));
      throw new Error(`no image results within 15 s: ${JSON.stringify(why)}`);
    }
    const stats = await frame.evaluate(() => ({ ...window.__holoweb.images.stats, session: Boolean(window.__holoweb.bridge.device.activeSession) }));
    await writeFile(join(shotDir, `${label.split(' ')[0].toLowerCase()}-image-tracking.png`), await page.screenshot());
    if (JSON.stringify(stats.lastScores) === '[]' || stats.lastScores.includes('untrackable')) problems.push(`scores ${JSON.stringify(stats.lastScores)}`);
    report(label, problems, `scores=${JSON.stringify(stats.lastScores)} resultQueries=${stats.resultQueries} framesWithResults=${stats.framesWithResults}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    report(label, problems);
  }
  await context.close();
  return problems.length ? 1 : 0;
}

export async function runImageChecks(env) {
  let failures = await exampleCase(env);
  failures += await liveCase(
    env,
    'PlayCanvas image tracking (live, same-origin iframe)',
    PLAYCANVAS,
    async (page) => {
      await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.contentWindow?.pc?.app?.xr), null, { timeout: 30000 });
      await page.waitForTimeout(2000); // the app configures app.xr.imageTracking after load
      await page.mouse.click(195, 422); // the app starts AR on a tap
    },
    async (page) => page.frames().find((f) => f.url().includes('/apps/')),
  );
  failures += await liveCase(
    env,
    'Needle image tracking (live)',
    NEEDLE,
    async (page) => {
      await page.getByRole('button', { name: /Enter AR/ }).click({ timeout: 30000 }); // in needle-menu's shadow root
    },
    async (page) => page.mainFrame(),
  );
  return { failures, cases: 3 };
}
