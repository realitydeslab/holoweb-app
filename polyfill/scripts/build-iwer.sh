#!/bin/bash
# Rebuild polyfill/vendor/iwer-2.7.0-pr208.tgz: IWER from meta-quest/immersive-web-emulation-runtime
# PR #208 (upstream XRGPUBinding / WebGPU layers), pinned to the commit below. Needs git, node, pnpm.
# Once the PR is released on npm, replace the file: dependency with the release and delete this script.
#
# Usage: scripts/build-iwer.sh [workdir]   (default: a temporary directory, deleted afterwards)
# A rebuilt tarball can differ byte-for-byte (timestamps): run `npm install` afterwards to refresh
# the integrity hash in package-lock.json, or `npm ci` fails.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=https://github.com/meta-quest/immersive-web-emulation-runtime.git
PR=208
SHA=ce99bce0d9bdffe504b85d87eb4c596d1cd201d4
OUT=vendor/iwer-2.7.0-pr208.tgz

if [ -n "${1:-}" ]; then
  WORK="$1"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
fi
git clone --quiet "$REPO" "$WORK/src"
git -C "$WORK/src" fetch --quiet origin "pull/$PR/head"
git -C "$WORK/src" checkout --quiet "$SHA"
(cd "$WORK/src" && pnpm install --frozen-lockfile --silent && pnpm --filter iwer run build >/dev/null)
(cd "$WORK/src/packages/iwer" && pnpm pack --pack-destination "$WORK" >/dev/null)
mkdir -p vendor
cp "$WORK/iwer-2.7.0.tgz" "$OUT"
echo "built $OUT from PR #$PR at $SHA"
