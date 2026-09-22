// Hand tracking e2e: examples/three-ar-hands.html with three.js' XRHandModelFactory against the mock's
// synthetic right hand (pinching every 2.4 s). Checks, per backend: one hand input source with 25
// tracked joints, at least one hand `select` (pinch) that dropped a cube, hand model pixels on screen,
// no console errors.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.0\/(.*)$/;

async function handsCase({ browser, base, root, shotDir }, backend) {
  const problems = [];
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 200)}`);
    if (m.type() === 'warning' && /WebGL|GL_|WebGPU|GPU/.test(m.text())) problems.push(`gpu warning: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route(CDN, async (route) => {
    const file = route.request().url().match(CDN)[1];
    await route.fulfill({ body: await readFile(join(root, 'node_modules/three', file)), contentType: 'text/javascript' });
  });
  const label = `three-ar-hands.html [${backend}]`;
  try {
    await page.goto(`${base}/examples/three-ar-hands.html?backend=${backend}`);
    await page.locator('button', { hasText: 'START AR' }).click({ timeout: 10000 });
    await page.waitForFunction(() => window.__handStatus.hands > 0 && window.__handStatus.joints === 25, null, { timeout: 10000 });
    await page.waitForFunction(() => window.__handStatus.cubes > 0, null, { timeout: 8000 });
    const status = await page.evaluate(() => window.__handStatus);
    const png = await page.screenshot();
    await writeFile(join(shotDir, `three-ar-hands-${backend}.png`), png);
    const drawn = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = new OffscreenCanvas(img.width, img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220) n++;
      return n;
    }, png.toString('base64'));
    if (status.hands !== 1) problems.push(`${status.hands} hand input sources`);
    if (drawn < 500) problems.push(`hand model not visible (${drawn} px)`);
    problems.push(...status.errors.map((e) => `page error: ${e}`));
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'} ${label}: backend=${status.backend} hands=${status.hands} joints=${status.joints} ` +
        `handSelects=${status.handSelects} cubes=${status.cubes} drawnPx=${drawn}`,
    );
  } catch (err) {
    problems.push(String(err.message ?? err).split('\n')[0]);
    console.log(`FAIL ${label}`);
  }
  for (const p of problems) console.log(`    ${p}`);
  await context.close();
  return problems.length ? 1 : 0;
}

export async function runHandChecks(env) {
  let failures = 0;
  for (const backend of ['webgpu', 'webgl']) failures += await handsCase(env, backend);
  return { failures, cases: 2 };
}
