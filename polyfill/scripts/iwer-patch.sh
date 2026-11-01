#!/bin/bash
# Regenerate patches/iwer+2.7.0.patch from node_modules/iwer (edited by hand) against the vendored
# tarball. `npx patch-package iwer` cannot: it reinstalls iwer@2.7.0 from the registry, and this
# build only exists as vendor/iwer-2.7.0-pr208.tgz. patch-package still applies the patch on install.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/orig/node_modules" "$WORK/node_modules"
tar -xzf vendor/iwer-2.7.0-pr208.tgz -C "$WORK/orig/node_modules"
mv "$WORK/orig/node_modules/package" "$WORK/orig/node_modules/iwer"
cp -R node_modules/iwer "$WORK/node_modules/iwer"
# git diff --no-index exits 1 when the trees differ; anything above 1 is an error
rc=0
(cd "$WORK" && git diff --no-index orig/node_modules/iwer node_modules/iwer > raw.patch) || rc=$?
if [ "$rc" -gt 1 ]; then echo "git diff failed ($rc)" >&2; exit 1; fi
if ! grep -q 'HOLOWEB:' "$WORK/raw.patch"; then echo 'no HOLOWEB hunks in node_modules/iwer; patch left unchanged' >&2; exit 1; fi
sed -e 's#a/orig/node_modules/iwer#a/node_modules/iwer#g' "$WORK/raw.patch" > patches/iwer+2.7.0.patch
echo "patches/iwer+2.7.0.patch: $(grep -c '^diff --git' patches/iwer+2.7.0.patch) files, $(grep -c 'HOLOWEB:' patches/iwer+2.7.0.patch) HOLOWEB hunks"
