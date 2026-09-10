#!/usr/bin/env bash
# Full verification for the bridge: both chains and the replication tooling.
set -e
cd "$(dirname "$0")"
echo "=== cairo: build + tests ==="
(cd cairo && scarb build && snforge test)
echo "=== evm: build + tests ==="
(cd evm/script && bash test.sh)
echo "=== tools: spec encoding ==="
(cd tools && node spec.test.js)
echo "=== note derivation: SDK vs the pool formula ==="
(cd frontend && node src/notes.test.mjs)
echo "=== pool check: which Veil pool, and does it exist ==="
(cd frontend && npx esbuild src/pools.ts --bundle --format=esm --platform=node \
   --outfile=src/pools.bundle.mjs --define:import.meta.env='{}' --log-level=error \
 && node src/pools.test.mjs && rm -f src/pools.bundle.mjs)
echo "=== compliance export: live token -> spec -> calldata ==="
(cd tools && node compliance-export.test.js)
echo
echo "all bridge suites passed"
