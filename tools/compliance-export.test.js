#!/usr/bin/env node
// Integration test for ONE workflow: reading an ERC-3643 token's compliance
// rules and turning them into apply_spec calldata.
//
// This is NOT an end-to-end test of the bridge. It never touches LayerZero, the
// gateway, or a message. It was called "e2e" and that was wrong: it passed
// while the app was half-wired, while starknet.js could not reach Sepolia, and
// while no contract could hold the twin. A green run here says the export tool
// works, and nothing else.
//
// What it does cover, with real bytecode over real HTTP JSON-RPC:
//
//   a real T-REX deployment, real EVM bytecode
//     -> export-compliance.js, over real HTTP JSON-RPC (eth_call + eth_getLogs)
//       -> spec.json
//         -> apply-compliance.js
//           -> apply_spec calldata for MirroredCompliance
//
// The cases that matter are the ones a unit test cannot reach, because they
// only exist as the difference between a chain's history and its current state:
//
//   * a country allowed and later WITHDRAWN -- still in the logs, gone from
//     live state. An exporter trusting events would reinstate a rule the issuer
//     removed.
//   * the max balance, which has NO getter anywhere in T-REX and can ONLY come
//     from an event -- and must be the latest one.
//
// Both are asserted from the file the tool actually wrote, not from an internal
// call. The exporter runs as a subprocess against a URL, exactly as in use.
//
// The node behind that URL is `evm/test/rpcnode.js`, serving the same
// @ethereumjs/evm chain the rest of the suite uses, because ganache ships no
// native module for Node 22 and installing a node binary to run a test is worse
// than serving the chain we already have.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

// MUST be async. The RPC node runs in THIS process, so a synchronous spawn
// would block the event loop that has to answer the child's requests -- the
// parent waits for the child, the child waits for the parent, and the suite
// hangs with no output. Learned the hard way.
const execFileAsync = promisify(execFile);
const { Chain_ } = require('../evm/test/harness');
const { serve } = require('../evm/test/rpcnode');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-bridge-e2e-'));
const US = 840, FR = 250, KP = 408;
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const ALICE = addr(0xa11ce);
const BOB = addr(0xb0b);

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    failures.push(name);
  }
}

/// A T-REX deployment configured the way an issuer would, including the two
/// states only a real chain history can produce.
async function setupChain() {
  const chain = await Chain_.create();
  const compliance = await chain.deploy('MockModularCompliance');
  const registry = await chain.deploy('MockIdentityRegistry');
  const token = await chain.deploy('MockERC3643Token', [registry.hex, compliance.hex]);
  await compliance.call('setTokenBound', [token.hex]);

  const countryAllow = await chain.deploy('MockCountryAllowModule');
  const countryRestrict = await chain.deploy('MockCountryRestrictModule');
  const supplyLimit = await chain.deploy('MockSupplyLimitModule');
  const transferRestrict = await chain.deploy('MockTransferRestrictModule');
  const maxBalance = await chain.deploy('MockMaxBalanceModule');
  const hostile = await chain.deploy('MockHostileModule');
  for (const m of [countryAllow, countryRestrict, supplyLimit, transferRestrict, maxBalance, hostile]) {
    await compliance.call('addModule', [m.hex]);
  }

  // US and France allowed...
  await countryAllow.call('setCountryAllowed', [compliance.hex, US, true]);
  await countryAllow.call('setCountryAllowed', [compliance.hex, FR, true]);
  // ...then France withdrawn. The CountryAllowed log for FR still exists.
  await countryAllow.call('setCountryAllowed', [compliance.hex, FR, false]);

  await countryRestrict.call('setCountryRestricted', [compliance.hex, KP, true]);
  await supplyLimit.call('setSupplyLimit', [compliance.hex, 1_000_000n]);
  // Bob allowed, then disallowed: same trap, on the address allow-list.
  await transferRestrict.call('setUserAllowed', [compliance.hex, ALICE, true]);
  await transferRestrict.call('setUserAllowed', [compliance.hex, BOB, true]);
  await transferRestrict.call('setUserAllowed', [compliance.hex, BOB, false]);
  // Set twice: only the LATEST MaxBalanceSet is the cap.
  await maxBalance.call('setMaxBalance', [compliance.hex, 9999n]);
  await maxBalance.call('setMaxBalance', [compliance.hex, 5000n]);

  const reader = await chain.deploy('ComplianceReader');
  const node = await serve(chain);
  return { chain, node, token, compliance, reader, countryAllow };
}

async function runExport(rig, extra = []) {
  const out = path.join(TMP, `spec-${Math.random().toString(36).slice(2)}.json`);
  await execFileAsync(
    process.execPath,
    [
      path.join(__dirname, 'export-compliance.js'),
      '--rpc', rig.node.url,
      '--token', rig.token.hex,
      '--out', out,
      ...extra,
    ],
    { encoding: 'utf8', timeout: 120000 }
  );
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

async function main() {
  console.log('compliance export: live token -> spec -> apply_spec calldata\n');
  const rig = await setupChain();
  let exported;

  await test('the exporter reads a live T-REX deployment over JSON-RPC', async () => {
    exported = await runExport(rig);
    assert.strictEqual(
      exported.report.compliance.toLowerCase(),
      rig.compliance.hex.toLowerCase(),
      'compliance address'
    );
    assert.strictEqual(exported.report.modules.length, 6, 'modules discovered');
  });

  await test('a country allowed then withdrawn is NOT replicated', async () => {
    assert.deepStrictEqual(
      exported.spec.allowedCountries, [US],
      `expected only US, got ${JSON.stringify(exported.spec.allowedCountries)}`
    );
    assert.strictEqual(exported.spec.countryAllowEnabled, true);
  });

  await test('a user allowed then disallowed is NOT replicated', async () => {
    const ids = exported.spec.allowedIdentities.map((a) => a.toLowerCase());
    assert.deepStrictEqual(ids, [ALICE.toLowerCase()],
      `expected only alice, got ${JSON.stringify(ids)}`);
  });

  await test('a restricted country is replicated', async () => {
    assert.deepStrictEqual(exported.spec.restrictedCountries, [KP]);
    assert.strictEqual(exported.spec.countryRestrictEnabled, true);
  });

  await test('the max balance is recovered from events despite having no getter', async () => {
    assert.strictEqual(exported.spec.maxBalance, '5000',
      `expected the latest cap 5000, got ${exported.spec.maxBalance}`);
    assert.strictEqual(exported.spec.maxBalanceEnabled, true);
    assert.ok(
      exported.report.warnings.some((w) => w.includes('EVENT-DERIVED')),
      'the event-derived caveat must be reported'
    );
  });

  await test('the supply limit is read from its getter', async () => {
    assert.strictEqual(exported.spec.supplyLimit, '1000000');
    assert.strictEqual(exported.spec.supplyLimitEnabled, true);
  });

  await test('an unrecognized module is reported as NOT mirrored', async () => {
    const names = exported.report.unmirrored.map((m) => m.name);
    assert.ok(names.includes('HostileModule'),
      `expected HostileModule in unmirrored, got ${JSON.stringify(names)}`);
  });

  await test('the batched reader path produces an identical spec', async () => {
    const viaReader = await runExport(rig, ['--reader', rig.reader.hex]);
    assert.deepStrictEqual(viaReader.spec, exported.spec,
      'reader-batched and direct-call exports must agree');
  });

  await test('the export tracks live state, not a first answer', async () => {
    await rig.countryAllow.call('setCountryAllowed', [rig.compliance.hex, US, false]);
    const after = await runExport(rig);
    assert.deepStrictEqual(after.spec.allowedCountries, [], 'US should be gone');
    await rig.countryAllow.call('setCountryAllowed', [rig.compliance.hex, US, true]);
    const restored = await runExport(rig);
    assert.deepStrictEqual(restored.spec.allowedCountries, [US], 'US should be back');
  });

  await test('apply-compliance turns the exported file into apply_spec calldata', async () => {
    const specPath = path.join(TMP, 'applied.json');
    fs.writeFileSync(specPath, JSON.stringify(exported));
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, 'apply-compliance.js'), '--spec', specPath, '--compliance', '0x1', '--json'],
      { encoding: 'utf8', timeout: 60000 }
    );
    const { calldata } = JSON.parse(stdout);
    // Field order per ComplianceSpec: allow flag, allowed[], restrict flag,
    // restricted[], max flag, u256 max, supply flag, u256 supply, tr flag, ids[]
    assert.deepStrictEqual(calldata.slice(0, 12), [
      '1', '1', String(US), '1', '1', String(KP), '1', '5000', '0', '1', '1000000', '0',
    ], `unexpected calldata: ${JSON.stringify(calldata)}`);
    assert.strictEqual(calldata[12], '1', 'transfer restrict flag');
    assert.strictEqual(calldata[13], '1', 'identity count');
    assert.strictEqual(BigInt(calldata[14]), BigInt(ALICE), 'identity is alice');
  });

  await test('the exporter surfaces an RPC failure instead of writing a wrong spec', async () => {
    // A half-read chain must not silently produce an under-specified rule set.
    let threw = false;
    try {
      await execFileAsync(
        process.execPath,
        [path.join(__dirname, 'export-compliance.js'), '--rpc', 'http://127.0.0.1:1', '--token', rig.token.hex,
         '--out', path.join(TMP, 'never.json')],
        { encoding: 'utf8', timeout: 60000 }
      );
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, 'exporter should exit non-zero when the node is unreachable');
    assert.ok(!fs.existsSync(path.join(TMP, 'never.json')), 'no spec should be written');
  });

  await rig.node.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
