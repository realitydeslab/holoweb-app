#!/bin/bash
# Builds the WebXR polyfill and copies it (plus its example pages) into the app's
# bundled Web/ folder. HoloWebState injects Web/holoweb-polyfill.js at document start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/polyfill"
[ -d node_modules ] || npm ci
npm run build
WEB="$ROOT/HoloWeb/Web"
cp dist/holoweb-polyfill.js "$WEB/holoweb-polyfill.js"
mkdir -p "$WEB/examples"
cp examples/*.js "$WEB/examples/"
for f in examples/*.html; do
  sed 's#\.\./dist/holoweb-polyfill\.js#../holoweb-polyfill.js#' "$f" > "$WEB/examples/$(basename "$f")"
done
# example assets (image-tracking marker, 0.15 m wide)
mkdir -p "$WEB/examples/assets"
cp examples/assets/* "$WEB/examples/assets/"
# three.js r186 AR examples with local three + assets (offline; scripts/vendor-threejs.mjs)
mkdir -p "$WEB/examples/threejs"
cp -R examples/threejs/. "$WEB/examples/threejs/"
ls -l "$WEB/holoweb-polyfill.js" "$WEB/examples" "$WEB/examples/assets" "$WEB/examples/threejs"
