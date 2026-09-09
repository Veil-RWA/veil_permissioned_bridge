#!/usr/bin/env bash
# One-time dev setup: install the EVM/tooling deps and link them where the
# test and tool directories expect to find them.
#
# The link layout mirrors the convention the Veil contracts repo uses: one
# install under evm/script, symlinked in from the directories that need it, so
# there is exactly one node_modules to manage.
set -e
cd "$(dirname "$0")"
(cd evm/script && npm install)
ln -sfn ../script/node_modules evm/test/node_modules
ln -sfn ../evm/script/node_modules tools/node_modules
echo "done. run: bash test.sh"
