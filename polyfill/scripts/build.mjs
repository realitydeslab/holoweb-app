// Builds dist/holoweb-polyfill.js (minified IIFE) and dist/holoweb-polyfill.dev.js.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_BUDGET = 250 * 1024;

// IWER imports webxr-layers-polyfill statically but only instantiates it for
// installRuntime({ polyfillLayers: true }), which HoloWeb never passes.
const stubLayersPolyfill = {
  name: 'stub-webxr-layers-polyfill',
  setup(b) {
    b.onResolve({ filter: /^webxr-layers-polyfill$/ }, () => ({ path: 'webxr-layers-polyfill', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents:
        "export default class WebXRLayerPolyfill { constructor() { throw new Error('webxr-layers-polyfill is not bundled in HoloWeb'); } }",
      loader: 'js',
    }));
  },
};

const common = {
  plugins: [stubLayersPolyfill],
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari17', 'chrome120'],
  legalComments: 'eof',
  banner: { js: '/* HoloWeb WebXR polyfill. Includes IWER 2.4.0 (MIT, Meta Platforms) and gl-matrix (MIT). */' },
  logLevel: 'warning',
};

await build({ ...common, outfile: resolve(root, 'dist/holoweb-polyfill.dev.js'), sourcemap: 'inline' });
const result = await build({
  ...common,
  outfile: resolve(root, 'dist/holoweb-polyfill.js'),
  minify: true,
  metafile: true,
});

const report = (file) => {
  const path = resolve(root, 'dist', file);
  const bytes = statSync(path).size;
  const gz = gzipSync(readFileSync(path)).length;
  console.log(`${file}: ${(bytes / 1024).toFixed(1)} KB (${(gz / 1024).toFixed(1)} KB gzip)`);
  return bytes;
};
const minBytes = report('holoweb-polyfill.js');
report('holoweb-polyfill.dev.js');

// metafile.inputs also lists tree-shaken files; check what actually reached the output.
const [output] = Object.values(result.metafile.outputs);
const bundled = Object.entries(output.inputs).filter(([, v]) => v.bytesInOutput > 0);
const forbidden = bundled
  .map(([p]) => p)
  .filter((p) => /iwer\/lib\/(remote|native)\/|@iwer\/(devui|sem)/.test(p));
if (process.env.HOLOWEB_BUILD_REPORT) {
  bundled
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, 15)
    .forEach(([p, v]) => console.log(`  ${(v.bytesInOutput / 1024).toFixed(1).padStart(6)} KB  ${p}`));
}
if (forbidden.length) {
  console.error('Excluded IWER modules leaked into the bundle:\n  ' + forbidden.join('\n  '));
  process.exit(1);
}
if (minBytes > SIZE_BUDGET) {
  console.error(`Bundle exceeds ${SIZE_BUDGET / 1024} KB budget`);
  process.exit(1);
}
