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
  'tests/exit-button': {
    // immersive-vr only (G7); tapping the in-world ButtonNode at (0, 1.2, -0.65) in local-floor calls session.end()
    async run(page, problems) {
      // remember the VR session itself: when it ends, the page's parked inline session becomes active again (G3)
      const mode = await page.evaluate(() => {
        const vr = (window.__vrSession = window.__holoweb.bridge.device.activeSession);
        vr.addEventListener('end', () => (window.__vrEnded = true));
        return vr.environmentBlendMode;
      });
      for (let attempt = 0; attempt < 6; attempt++) {
        const target = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const session = window.__vrSession;
              if (window.__vrEnded) return resolve(null);
              setTimeout(() => resolve(null), 2000); // the session may end (the goal) before the next frame
              session.requestReferenceSpace('local-floor').then((floor) =>
                session.requestAnimationFrame((_t, frame) => {
                  const view = frame.getViewerPose(floor)?.views[0];
                  if (!view) return resolve(null);
                  const p = [0, 1.2, -0.65, 1];
                  const inv = view.transform.inverse.matrix;
                  const pr = view.projectionMatrix;
                  const mul = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
                  const clip = mul(pr, mul(inv, p));
                  resolve({ x: ((clip[0] / clip[3] + 1) / 2) * innerWidth, y: ((1 - clip[1] / clip[3]) / 2) * innerHeight, w: clip[3] });
                }),
              );
            }),
        );
        if (!target) break;
        if (target.w > 0) await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(300);
      }
      const ended = await page.evaluate(() => window.__vrEnded === true);
      if (mode !== 'opaque') problems.push(`blend mode ${mode}, expected opaque (immersive-vr)`);
      if (!ended) problems.push('tapping the in-world exit button did not end the session');
      const inlineBack = await page.evaluate(() => window.__holoweb.bridge.device.activeSession !== window.__vrSession && Boolean(window.__holoweb.bridge.device.activeSession));
      return `immersive-vr (${mode}), ended by in-world button=${ended}, inline session resumed=${inlineBack}`;
    },
  },
  'immersive-hands': {
    // tries immersive-vr first; hand-tracking optional; the mock sends a pinching right hand
    async run(page, problems) {
      await page.waitForTimeout(600);
      const hands = await page.evaluate(() => [...window.__holoweb.bridge.device.activeSession.inputSources].filter((s) => s.hand).map((s) => `${s.handedness}:${s.hand.size}`));
      if (!hands.includes('right:25')) problems.push(`hand input sources ${JSON.stringify(hands)}`);
      return `hands=${JSON.stringify(hands)}`;
    },
  },
  'webgpu/immersive-ar-session': {
    async run(page, problems) {
      const layers = await page.evaluate(() => (window.__holoweb.bridge.device.activeSession.renderState.layers ?? []).length);
      if (layers !== 1) problems.push(`renderState.layers length ${layers}`);
      return `XRGPUBinding projection layer=${layers}`;
    },
  },
  'webgpu/immersive-hands': {
    async run(page, problems) {
      await page.waitForTimeout(600);
      const hands = await page.evaluate(() => [...window.__holoweb.bridge.device.activeSession.inputSources].filter((s) => s.hand).length);
      if (hands < 1) problems.push('no hand input source');
      return `hands=${hands}`;
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
  for (const name of names) {
    const limit = new Promise((resolve) => setTimeout(() => resolve('timeout'), 90000));
    const result = await Promise.race([runSample(env, name, SAMPLES[name]), limit]);
    if (result === 'timeout') console.log(`FAIL webxr-samples/${name}: timed out after 90 s`);
    failures += result === 'timeout' ? 1 : result;
  }
  return { failures, cases: names.length };
}
