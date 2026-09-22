// immersive-web/webxr-samples (live https://immersive-web.github.io/webxr-samples/, network needed;
// skipped offline) with the bundle injected at document start against mock-native, the page's
// enter button (.webvr-ui-button) clicked. Checks use page-agnostic observations only: the active
// session and its mode, XR frames sampled through the page's own session, polyfill counters.
// See plan/samples_requirements.md for each page's API use.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://immersive-web.github.io/webxr-samples/';

/** Frames and view count of the frame's active session, sampled with its own rAF. */
const sampleXR = (page, n = 15) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const session = window.__holoweb.bridge.device.activeSession;
        if (!session) return resolve({ frames: 0, views: 0, mode: null });
        const mode = session.environmentBlendMode === 'opaque' ? 'immersive-vr' : 'immersive-ar';
        session.requestReferenceSpace('local').then((local) => {
          let frames = 0;
          let views = 0;
          const tick = (_t, f) => {
            frames++;
            views = f.getViewerPose(local)?.views.length ?? 0;
            if (frames < n) session.requestAnimationFrame(tick);
            else resolve({ frames, views, mode });
          };
          session.requestAnimationFrame(tick);
        });
        setTimeout(() => resolve({ frames: 0, views: 0, mode, timeout: true }), 4000);
      }),
    n,
  );

const tap = async (page, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.mouse.click(195, 500);
    await page.waitForTimeout(250);
  }
};

/** Per-sample scenario: returns a detail string, pushes problems. `allow` = expected page errors. */
const SAMPLES = {
  anchors: {
    async run(page, problems) {
      await tap(page, 3);
      const anchors = await page.evaluate(() => window.__holoweb.anchors.count);
      if (anchors < 1) problems.push('no native anchor after taps');
      return `anchors=${anchors}`;
    },
  },
  'hit-test': {
    async run(page, problems) {
      await page.waitForTimeout(800);
      const hits = await page.evaluate(() => window.__holoweb.bridge.environment.hitQueries);
      await tap(page);
      if (hits < 1) problems.push('no hit-test results');
      return `hitQueries=${hits}`;
    },
  },
  'hit-test-anchors': {
    // select calls createAnchor() on the hit result kept from the previous frame (G4)
    async run(page, problems) {
      await page.waitForTimeout(800);
      await tap(page, 3);
      await page.waitForTimeout(300);
      const anchors = await page.evaluate(() => window.__holoweb.anchors.count);
      if (anchors < 1) problems.push('no anchor from a kept hit result');
      return `anchors=${anchors}`;
    },
  },
  'proposals/plane-detection': {
    // domOverlay root = body with a beforexrselect-cancelling header (G6); select anchors on a plane
    async run(page, problems) {
      await page.waitForTimeout(800);
      const header = await page.evaluate(() => {
        const h = document.querySelector('header');
        if (!h) return 'no header';
        const r = h.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
        return h.contains(top) ? 'on top' : `covered by ${top?.tagName}`;
      });
      const before = await page.evaluate(() => window.__holoweb.anchors.count);
      await tap(page, 2);
      await page.waitForTimeout(300);
      const { anchors, planes } = await page.evaluate(() => ({ anchors: window.__holoweb.anchors.count, planes: window.__holoweb.planes.count }));
      if (header !== 'on top') problems.push(`overlay header ${header}`);
      if (anchors <= before) problems.push('select did not create an anchor');
      if (planes < 1) problems.push('no planes tracked');
      return `header ${header}, planes=${planes}, anchors=${anchors}`;
    },
  },
  'tests/interrupted-ar': {
    // the page throws on purpose right after the session resolves, then sets its layer 5 s later
    allow: [/Exception is not defined/],
    allowNoFrames: true, // no layer (so no XR frames) for the first 5 s, by design
    async run(page, problems) {
      const early = await page.evaluate(() => Boolean(window.__holoweb.bridge.device.activeSession?.renderState.baseLayer));
      await page.waitForTimeout(5800);
      const late = await page.evaluate(() => Boolean(window.__holoweb.bridge.device.activeSession?.renderState.baseLayer));
      const xr = await sampleXR(page);
      if (early || !late) problems.push(`baseLayer before 5 s: ${early}, after: ${late}`);
      if (xr.frames < 15) problems.push(`no XR frames after the late layer (${xr.frames})`);
      return `session alive 5 s without a layer, then baseLayer=${late}, frames=${xr.frames}`;
    },
  },
};

async function runSample({ browser, root, shotDir }, name, spec) {
  const problems = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const allowed = (text) => (spec.allow ?? []).some((re) => re.test(text));
  page.on('pageerror', (e) => !allowed(e.message) && problems.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on('console', (m) => m.type() === 'error' && !allowed(m.text()) && /XR|Session|HoloWeb/i.test(m.text()) && problems.push(`console.error: ${m.text().slice(0, 160)}`));
  await page.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
  try {
    try {
      await page.goto(BASE + name + '.html', { waitUntil: 'load', timeout: 30000 });
    } catch (err) {
      console.log(`SKIP webxr-samples/${name} (network): ${String(err.message).split('\n')[0]}`);
      await context.close();
      return 0;
    }
    const button = page.locator('.webvr-ui-button');
    await button.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('.webvr-ui-button')?.disabled, null, { timeout: 10000 });
    await button.click({ timeout: 10000 });
    await page.waitForFunction(() => window.__holoweb.bridge.device.activeSession?.environmentBlendMode !== undefined &&
      window.__holoweb.bridge.readyPosts > 0 && Boolean(window.__holoweb.bridge.latest), null, { timeout: 10000 });
    const xr = await sampleXR(page);
    const detail = await spec.run(page, problems);
    await writeFile(join(shotDir, `webxr-samples-${name.replace(/\//g, '_')}.png`), await page.screenshot());
    if (!xr.frames && !spec.allowNoFrames) problems.push('no XR frames');
    console.log(`${problems.length ? 'FAIL' : 'PASS'} webxr-samples/${name}: ${xr.mode} frames=${xr.frames} views=${xr.views}; ${detail}`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log(`FAIL webxr-samples/${name}`);
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

export async function runSampleChecks(env) {
  const names = process.env.HOLOWEB_E2E_SAMPLES ? process.env.HOLOWEB_E2E_SAMPLES.split(',') : Object.keys(SAMPLES);
  let failures = 0;
  for (const name of names) failures += await runSample(env, name, SAMPLES[name]);
  return { failures, cases: names.length };
}
