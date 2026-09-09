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
echo "=== end-to-end: live chain -> export -> apply_spec calldata ==="
(cd tools && node e2e.test.js)
echo
echo "all bridge suites passed"
