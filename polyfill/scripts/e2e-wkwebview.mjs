// Make headless Chromium look like WKWebView to the polyfill: no navigator.xr and no WebXR interface
// globals (Chromium ships XRRay, XRRigidTransform, XRWebGLLayer, XRHand, ... which used to hide
// globals the polyfill did not install). Runs in every frame of every context, before page scripts.
// Only native-code XR* constructors are deleted, so the strip is harmless if it runs after the bundle.

function stripWebXR() {
  const isNative = (v) => typeof v === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(v));
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!/^XR[A-Z]/.test(name)) continue;
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (d && isNative(d.value)) delete globalThis[name];
  }
  if (isNative(Object.getOwnPropertyDescriptor(Navigator.prototype, 'xr')?.get)) delete Navigator.prototype.xr;
}

/** Wrap browser.newContext so every context starts without Chromium's WebXR. */
export function mimicWKWebView(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(stripWebXR);
    return context;
  };
  return browser;
}

/** A page with the bundle: Chromium's WebXR is gone, and the polyfill supplies every WebXR global. */
export async function runGlobalsChecks({ browser, base }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try {
    await page.goto(`${base}/examples/fixtures/iframe-host.html`);
    await page.waitForFunction(() => Boolean(window.__holoweb), null, { timeout: 10000 });
    const r = await page.evaluate(() => {
      const native = Object.getOwnPropertyNames(globalThis).filter(
        (n) => /^XR[A-Z]/.test(n) && typeof globalThis[n] === 'function' && /\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(globalThis[n])),
      );
      const ray = new XRRay(new DOMPoint(0, 1, 0), new DOMPoint(0, 0, -2));
      const fromTransform = new XRRay(new XRRigidTransform({ x: 1, y: 0, z: 0 }));
      return {
        missing: window.__holoweb.missingGlobals(),
        native,
        rayDir: [ray.direction.x, ray.direction.y, ray.direction.z],
        rayMatrix: ray.matrix.length,
        fromTransformOrigin: fromTransform.origin.x,
        xr: navigator.xr instanceof XRSystem,
      };
    });
    if (r.native.length) problems.push(`Chromium WebXR globals left: ${r.native.join(', ')}`);
    if (r.missing.length) problems.push(`missing globals: ${r.missing.join(', ')}`);
    if (r.rayDir.join() !== '0,0,-1' || r.rayMatrix !== 16 || r.fromTransformOrigin !== 1) problems.push(`XRRay: ${JSON.stringify(r)}`);
    if (!r.xr) problems.push('navigator.xr is not the polyfill XRSystem');
    console.log(`${problems.length ? 'FAIL' : 'PASS'} WebXR globals under WKWebView conditions: missing=[${r.missing}] chromiumLeft=[${r.native}] XRRay ok`);
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log('FAIL WebXR globals');
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return { failures: problems.length ? 1 : 0, cases: 1 };
}
