// three.js r186 official AR examples, unmodified, against mock-native:
//   webxr_ar_hittest          reticle (RingGeometry) becomes visible from hit-test results
//   webxr_ar_plane_detection  XRPlanes builds one mesh per detected plane; the mock's plane update
//                             (floor grows, lastChanged changes) must not duplicate meshes (stable identity)
//   webxr_ar_lighting         XREstimatedLight starts estimating (it is added to the scene) and its
//                             environment is the polyfill's cube map from getReflectionCubeMap after a
//                             reflectionchange. scene.environment is informational: the page also loads a
//                             2K HDR default environment from the network and its load callback overwrites
//                             scene.environment if it finishes after estimationstart (a race in the example).
// Pages: test/fixtures/threejs-r186 served at their threejs.org URLs (HOLOWEB_E2E_LIVE=1: live pages).
// three.js build/jsm come from node_modules/three (same r186). The bundle is injected at document start
// like the app does. The page's scene/renderer are observed through three's __THREE_DEVTOOLS__ hook.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SITE = 'https://threejs.org';
const LOCAL = [
  [/^https:\/\/threejs\.org\/build\/(.*)$/, 'node_modules/three/build'],
  [/^https:\/\/threejs\.org\/examples\/jsm\/(.*)$/, 'node_modules/three/examples/jsm'],
];

async function openExample({ browser, root }, name, problems) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  for (const [pattern, dir] of LOCAL) {
    await page.route(pattern, async (route) => {
      const file = route.request().url().match(pattern)[1].split('?')[0];
      await route.fulfill({ body: await readFile(join(root, dir, file)), contentType: 'text/javascript' });
    });
  }
  if (!process.env.HOLOWEB_E2E_LIVE) {
    await page.route(`${SITE}/examples/${name}.html`, async (route) =>
      route.fulfill({ body: await readFile(join(root, 'test/fixtures/threejs-r186', `${name}.html`)), contentType: 'text/html' }),
    );
  }
  await page.addInitScript(() => {
    window.__observed = [];
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', (e) => window.__observed.push(e.detail));
  });
  await page.addInitScript({ path: join(root, 'dist/holoweb-polyfill.js') });
  await page.goto(`${SITE}/examples/${name}.html`, { waitUntil: 'load', timeout: 30000 });
  await page.locator('#ARButton', { hasText: 'START AR' }).click({ timeout: 10000 });
  await page.waitForFunction(() => Boolean(window.__holoweb.bridge.device.activeSession), null, { timeout: 10000 });
  return { context, page };
}

const sceneOf = () => window.__observed.find((o) => o.isScene);

const CHECKS = {
  async webxr_ar_hittest(page) {
    await page.waitForFunction(
      (sceneOfSrc) => {
        const scene = new Function(`return (${sceneOfSrc})()`)();
        const reticle = scene?.children.find((o) => o.geometry?.type === 'RingGeometry');
        return reticle?.visible === true;
      },
      sceneOf.toString(),
      { timeout: 8000 },
    );
    return 'reticle visible from hit-test results';
  },

  async webxr_ar_plane_detection(page, problems) {
    const meshes = (min) =>
      page.waitForFunction(
        ([src, n]) => {
          const scene = new Function(`return (${src})()`)();
          const planes = scene?.children.find((o) => o.constructor.name === 'XRPlanes');
          return planes && planes.children.length >= n ? planes.children.length : false;
        },
        [sceneOf.toString(), min],
        { timeout: 8000 },
      );
    const first = await (await meshes(3)).jsonValue();
    await page.waitForTimeout(1500); // mock updates the floor at 1 s (new lastChanged, same id)
    const after = await page.evaluate((src) => {
      const scene = new Function(`return (${src})()`)();
      return scene.children.find((o) => o.constructor.name === 'XRPlanes').children.length;
    }, sceneOf.toString());
    if (after !== first) problems.push(`plane meshes ${first} -> ${after} after a plane update (identity not stable)`);
    return `XRPlanes meshes ${first} (after update ${after})`;
  },

  async webxr_ar_lighting(page, problems) {
    await page.waitForFunction(
      (src) => {
        const scene = new Function(`return (${src})()`)();
        const light = scene?.children.find((o) => o.constructor.name === 'XREstimatedLight');
        return Boolean(light?.environment && window.__holoweb.reflections.served > 0);
      },
      sceneOf.toString(),
      { timeout: 8000 },
    );
    const info = await page.evaluate((src) => {
      const scene = new Function(`return (${src})()`)();
      const light = scene.children.find((o) => o.constructor.name === 'XREstimatedLight');
      const renderer = window.__observed.find((o) => o.isWebGLRenderer);
      const texture = renderer?.properties.get(light.environment)?.__webglTexture;
      const gl = renderer?.getContext();
      return {
        fired: window.__holoweb.reflections.fired,
        served: window.__holoweb.reflections.served,
        isCube: Boolean(gl && texture && (gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture), gl.getError() === gl.NO_ERROR)),
        lightProbeIntensity: light.lightProbe.intensity,
        sceneUsesIt: scene.environment === light.environment,
      };
    }, sceneOf.toString());
    if (info.fired < 1) problems.push('no reflectionchange fired');
    if (!info.isCube) problems.push('environment texture is not the polyfill cube map');
    return (
      `reflectionchange=${info.fired} cubeMap served=${info.served} cube=${info.isCube} ` +
      `lightProbe.intensity=${info.lightProbeIntensity} scene.environment=${info.sceneUsesIt ? 'estimated' : 'default HDR (page race)'}`
    );
  },
};

export async function runThreeOfficialChecks(env) {
  let failures = 0;
  for (const name of Object.keys(CHECKS)) {
    const problems = [];
    let context;
    try {
      const opened = await openExample(env, name, problems);
      context = opened.context;
      const detail = await CHECKS[name](opened.page, problems);
      await writeFile(join(env.shotDir, `threejs-${name}.png`), await opened.page.screenshot());
      console.log(`${problems.length ? 'FAIL' : 'PASS'} threejs.org/examples/${name}.html (r186, ${process.env.HOLOWEB_E2E_LIVE ? 'live' : 'fixture'}): ${detail}`);
    } catch (err) {
      problems.push(String(err.message ?? err).split('\n')[0]);
      console.log(`FAIL threejs.org/examples/${name}.html`);
    }
    for (const p of problems) console.log(`    ${p}`);
    if (problems.length) failures++;
    await context?.close();
  }
  return { failures, cases: Object.keys(CHECKS).length };
}
