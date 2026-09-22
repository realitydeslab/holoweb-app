#!/bin/bash
# Builds the WebXR polyfill and copies it into the app's bundled Web/ folder,
# where HoloWebState injects it as a document-start user script.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/polyfill"
[ -d node_modules ] || npm ci
npm run build
cp dist/holoweb-polyfill.js "$ROOT/HoloWeb/Web/holoweb-polyfill.js"
ls -l "$ROOT/HoloWeb/Web/holoweb-polyfill.js"
