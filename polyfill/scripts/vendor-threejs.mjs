// Builds examples/threejs/: the three.js r186 official AR examples (webxr_ar_hittest, webxr_ar_lighting,
// webxr_ar_plane_detection) with everything they load, so the app can open them offline at
// holoweb-app://local/examples/threejs/<name>.html. Pages come from test/fixtures/threejs-r186
// (unmodified threejs.org copies); only the importmap is rewritten to the local build. three and the
// addons come from node_modules/three (0.186.0); main.css and the lighting page's HDR are fetched from
// threejs.org once (kept if present). Rerun after bumping three: `node scripts/vendor-threejs.mjs`.
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples/threejs');
const three = join(root, 'node_modules/three');
const PAGES = ['webxr_ar_hittest', 'webxr_ar_lighting', 'webxr_ar_plane_detection'];
const FILES = [
  ['build/three.module.js', 'build/three.module.js'],
  ['build/three.core.js', 'build/three.core.js'],
  ['examples/jsm/webxr/ARButton.js', 'jsm/webxr/ARButton.js'],
  ['examples/jsm/webxr/XRPlanes.js', 'jsm/webxr/XRPlanes.js'],
  ['examples/jsm/webxr/XREstimatedLight.js', 'jsm/webxr/XREstimatedLight.js'],
  ['examples/jsm/loaders/UltraHDRLoader.js', 'jsm/loaders/UltraHDRLoader.js'],
];
const REMOTE = ['main.css', 'textures/equirectangular/royal_esplanade_2k.hdr.jpg'];
const IMPORTMAP_FROM = '"three": "../build/three.module.js"';
const IMPORTMAP_TO = '"three": "./build/three.module.js"';

const version = JSON.parse(await readFile(join(three, 'package.json'), 'utf8')).version;
if (version !== '0.186.0') throw new Error(`node_modules/three is ${version}; the fixtures are r186`);

for (const name of PAGES) {
  const html = await readFile(join(root, 'test/fixtures/threejs-r186', `${name}.html`), 'utf8');
  if (!html.includes(IMPORTMAP_FROM)) throw new Error(`${name}: importmap not as expected`);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `${name}.html`), html.replace(IMPORTMAP_FROM, IMPORTMAP_TO));
}
for (const [from, to] of FILES) {
  await mkdir(dirname(join(out, to)), { recursive: true });
  await copyFile(join(three, from), join(out, to));
}
for (const path of REMOTE) {
  const dest = join(out, path);
  if (await stat(dest).then(() => true, () => false)) continue;
  const res = await fetch(`https://threejs.org/examples/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
console.log(`examples/threejs: ${PAGES.length} pages, three ${version}, ${FILES.length} modules, ${REMOTE.length} assets`);
