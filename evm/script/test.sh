#!/usr/bin/env bash
# Verification for the EVM half of the bridge.
set -e
cd "$(dirname "$0")/.."
echo "=== contracts: compile ==="
(cd script && node build.js)
echo "=== bridge: adversarial tests ==="
(cd test && node bridge.test.js)
echo "=== bridge: attack tests ==="
(cd test && node attack.test.js)
echo "=== permissioned ERC-20 kinds: allowlisted and rule-gated lockboxes ==="
(cd test && node kinds.test.js)
echo "=== cash leg: USDC burn into a Veil pool note (CCTP V2) ==="
(cd test && node cash.test.js)
echo "=== faucet: deployable ERC-3643 assets ==="
(cd test && node faucet.test.js)
