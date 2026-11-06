#!/usr/bin/env bash
# Vendors LayerZero's Soroban crates into ./dependencies, the layout the
# monorepo's own `build-utils-rust resolve` produces (a flat copy, path deps
# rewritten), from a checkout pinned at LZ_COMMIT.
set -euo pipefail
cd "$(dirname "$0")"
commit=$(cat LZ_COMMIT)
repo=${LZ_MONOREPO:-$PWD/.lz-monorepo}
if [ ! -d "$repo/.git" ]; then
  git clone --filter=blob:none https://github.com/LayerZero-Labs/monorepo-external "$repo"
fi
git -C "$repo" fetch --depth 1 origin "$commit" 2>/dev/null || true
git -C "$repo" checkout -q "$commit"
rm -rf dependencies
LZ_MONOREPO="$repo" python3 vendor.py .
