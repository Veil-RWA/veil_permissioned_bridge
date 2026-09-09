// Minimal EVM test harness for the bridge tree: compiles bridge/evm/contracts
// + test/Mocks.sol and runs them in @ethereumjs/evm. No node, no chain -- just
// real bytecode executing real opcodes.
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { EVM } = require('@ethereumjs/evm');
const { Common, Chain, Hardfork } = require('@ethereumjs/common');
const { hexToBytes, bytesToHex, Address } = require('@ethereumjs/util');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(path.join(d, e.name))
      : e.name.endsWith('.sol')
        ? [path.join(d, e.name)]
        : []
  );
}

let _artifacts = null;
function compile() {
  if (_artifacts) return _artifacts;
  const files = [...walk(path.join(ROOT, "contracts")), path.join(__dirname, "Mocks.sol")];
  const sources = {};
  for (const f of files) sources[path.relative(ROOT, f)] = { content: fs.readFileSync(f, 'utf8') };

  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources,
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: 'cancun',
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      }),
      {
        import: (p) => {
          for (const c of [path.join(ROOT, p), path.join(ROOT, 'contracts', p)]) {
            if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
          }
          return { error: 'not found: ' + p };
        },
      }
    )
  );
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));

  _artifacts = {};
  for (const f of Object.keys(out.contracts)) {
    for (const c of Object.keys(out.contracts[f])) {
      _artifacts[c] = {
        abi: out.contracts[f][c].abi,
        bytecode: out.contracts[f][c].evm.bytecode.object,
      };
    }
  }
  return _artifacts;
}

class Chain_ {
  constructor(evm) {
    this.evm = evm;
    this.artifacts = compile();
    this.nextAddr = 1;
    // Each successful call is treated as one block, and its logs are kept so
    // `rpcnode.js` can answer eth_getLogs over this same chain. Nothing else
    // reads these; the cost is one array push per emitting call.
    this.blockNumber = 0;
    this.logs = [];
  }

  recordLogs(execLogs) {
    this.blockNumber += 1;
    if (!execLogs || !execLogs.length) return;
    let logIndex = 0;
    for (const [address, topics, data] of execLogs) {
      this.logs.push({
        address: bytesToHex(address),
        topics: topics.map((t) => bytesToHex(t)),
        data: bytesToHex(data),
        blockNumber: this.blockNumber,
        logIndex: logIndex++,
      });
    }
  }

  static async create() {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
    const evm = await EVM.create({ common });
    return new Chain_(evm);
  }

  account(n) {
    return new Address(hexToBytes('0x' + n.toString(16).padStart(40, '0')));
  }

  async deploy(name, args = [], from = 1) {
    const art = this.artifacts[name];
    if (!art) throw new Error('unknown contract ' + name);
    const iface = new ethers.Interface(art.abi);
    const ctor = iface.deploy ? iface.encodeDeploy(args) : '0x';
    const res = await this.evm.runCall({
      caller: this.account(from),
      data: hexToBytes('0x' + art.bytecode + ctor.slice(2)),
      gasLimit: 200000000n,
    });
    if (res.execResult.exceptionError) {
      throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error}`);
    }
    return new Contract(this, name, res.createdAddress, iface);
  }
}

class Contract {
  constructor(chain, name, address, iface) {
    this.chain = chain;
    this.name = name;
    this.address = address;
    this.iface = iface;
  }

  get hex() {
    return bytesToHex(this.address.bytes);
  }

  /// Calls `fn`, returning { ok, error, decoded, gas }. Never throws on revert --
  /// the tests assert on the revert instead.
  async call(fn, args = [], from = 1, value = 0n) {
    const data = this.iface.encodeFunctionData(fn, args);
    const res = await this.chain.evm.runCall({
      to: this.address,
      caller: this.chain.account(from),
      data: hexToBytes(data),
      gasLimit: 100000000n,
      value,
    });
    const ret = bytesToHex(res.execResult.returnValue);
    if (res.execResult.exceptionError) {
      return { ok: false, error: decodeError(this.iface, ret), gas: res.execResult.executionGasUsed };
    }
    this.chain.recordLogs(res.execResult.logs);
    let decoded = null;
    try {
      decoded = this.iface.decodeFunctionResult(fn, ret);
    } catch (_) {}
    return { ok: true, decoded, gas: res.execResult.executionGasUsed, raw: ret };
  }
}

/// Turns revert data into a readable name: custom error selector, Error(string),
/// or the raw bytes.
function decodeError(iface, ret) {
  if (!ret || ret === '0x') return 'revert(no data)';
  // Error(string) first, so `require` messages come back as text rather than
  // the useless name "Error".
  try {
    if (ret.startsWith('0x08c379a0')) {
      return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + ret.slice(10))[0];
    }
  } catch (_) {}
  try {
    if (ret.startsWith('0x4e487b71')) {
      const code = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + ret.slice(10))[0];
      return `Panic(0x${code.toString(16)})`;
    }
  } catch (_) {}
  try {
    const parsed = iface.parseError(ret);
    if (parsed) return parsed.name;
  } catch (_) {}
  return ret.slice(0, 10);
}

// -------------------------------------------------------------- test runner

const tests = [];
let only = null;
function test(name, fn) {
  tests.push({ name, fn });
}
test.only = (name, fn) => {
  only = name;
  tests.push({ name, fn });
};

function eq(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual.toString() : actual;
  const e = typeof expected === 'bigint' ? expected.toString() : expected;
  if (a !== e) throw new Error(`${msg || 'mismatch'}: got ${a}, want ${e}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

/// Asserts a call reverted, and reverted for the stated reason.
function reverts(res, expected, msg) {
  if (res.ok) throw new Error(`${msg || 'call'}: expected revert "${expected}", but it SUCCEEDED`);
  if (!String(res.error).includes(expected)) {
    throw new Error(`${msg || 'call'}: expected revert "${expected}", got "${res.error}"`);
  }
}

function succeeds(res, msg) {
  if (!res.ok) throw new Error(`${msg || 'call'}: expected success, reverted with "${res.error}"`);
}

async function run() {
  let pass = 0;
  const failures = [];
  for (const t of tests) {
    if (only && t.name !== only) continue;
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${e.message}`);
      failures.push(t.name);
    }
  }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
}

module.exports = { Chain_, Contract, compile, test, eq, ok, reverts, succeeds, run, ethers };
