// Compiles every contract under evm/contracts with solc 0.8.28.
const fs = require('fs'), path = require('path'), solc = require('solc');
const ROOT = path.join(__dirname, '..', 'contracts');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.sol') ? [path.join(d, e.name)] : []
  );
}
const files = walk(ROOT);
const sources = {};
for (const f of files) sources[path.relative(ROOT, f)] = { content: fs.readFileSync(f, 'utf8') };

function findImport(p) {
  const cands = [path.join(ROOT, p), path.join(ROOT, path.basename(p))];
  for (const c of cands) if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
  return { error: 'not found: ' + p };
}

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } }
  }
}), { import: findImport }));

let errors = 0;
for (const e of out.errors || []) {
  if (e.severity === 'error') { errors++; console.error(e.formattedMessage); }
  else if (process.env.WARN) console.warn(e.formattedMessage.split('\n')[0]);
}
if (errors) { console.error(`\n${errors} error(s)`); process.exit(1); }

for (const f of Object.keys(out.contracts || {}).sort()) {
  for (const c of Object.keys(out.contracts[f])) {
    const sz = (out.contracts[f][c].evm.deployedBytecode.object || '').length / 2;
    if (sz > 0) console.log(`${(f + ':' + c).padEnd(46)} ${String(sz).padStart(6)} bytes${sz > 24576 ? '  OVER EIP-170' : ''}`);
  }
}
console.log('\nall contracts compiled');
