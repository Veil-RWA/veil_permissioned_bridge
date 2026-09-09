#!/usr/bin/env bash
# One-time dev setup: install deps for the contracts tests, the deployment
# scripts and the app, and link node_modules where the test/tool directories
# expect it (one install under evm/script, symlinked in from the rest).
set -e
cd "$(dirname "$0")"

echo "== contracts + tooling deps =="
(cd evm/script && npm install)
ln -sfn ../script/node_modules evm/test/node_modules
ln -sfn ../evm/script/node_modules tools/node_modules

echo "== deployment scripts =="
(cd scripts && npm install)

echo "== app =="
(cd frontend && npm install)

echo
echo "done."
echo "  tests:  bash test.sh"
echo "  app:    (cd frontend && npm run dev)"
echo "  deploy: see scripts/README.md"
