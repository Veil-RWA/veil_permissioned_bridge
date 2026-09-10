// Every way the pool check can answer, without a chain.
//
// This is the gate that stands between a user pasting an address and a real
// position being sent at it. The failure it exists to prevent is quiet: the
// gateway would decline an address that is not a pool and sweep the amount to
// the wallet, so nothing is lost -- but the user paid for a message and did not
// get what they asked for. Every branch below is a way that happens.

import assert from 'node:assert';
import { checkPool, normalisePoolAddress, POOL_PROBLEMS } from './pools.bundle.mjs';

const MAIN = '0x12808521ab5f277d84eb430f2d59ff8753e91947b43fcf9aea341b38481a80a';
const OWN = '0x66a7180b01cef03eea839305664efd321283137666318c32a02465835f4ba81';
const TWIN = '0x777';
const REGISTRY = '0x999';
const OWNER = '0x7f69f195543ee9bc33e3fb1bf4609e96d49a7cc9e22a136ed4a3f80570c7121';

const asset = (overrides = {}) => ({
  id: 'gold', symbol: 'XAU', name: 'Tokenized gold', category: 'Metal', decimals: 18,
  tint: ['#000', '#fff'],
  addresses: { starknet: { token: TWIN, pool: MAIN, registry: REGISTRY, ...overrides } },
  available: true, poolReady: true,
});

const FACTORY = '0x244b26034b77cd3bbafe6a506ec177e7981bf0620021f3082813fc22a40cbe8';

/// A chain that knows about the two pools the factory made.
function opts({ registered = [OWN, MAIN], carries = [TWIN], factoryThrows = false,
                poolThrows = false, factory = FACTORY, holders = [OWN, MAIN] } = {}) {
  const read = async (contract, entrypoint, calldata) => {
    if (entrypoint === 'get_pool_owner') {
      if (factoryThrows) throw new Error('rpc down');
      const asked = BigInt(calldata[0]);
      return [registered.some((p) => BigInt(p) === asked) ? OWNER : '0x0'];
    }
    if (entrypoint === 'is_token_allowed') {
      if (poolThrows) throw new Error('no such entrypoint');
      return [carries.some((t) => BigInt(t) === BigInt(calldata[0])) ? '0x1' : '0x0'];
    }
    if (entrypoint === 'is_verified') {
      return [holders.some((h) => BigInt(h) === BigInt(calldata[0])) ? '0x1' : '0x0'];
    }
    throw new Error(`unexpected call ${entrypoint}`);
  };
  return { read, factory };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

// ── address shape ────────────────────────────────────────────────────────────

await test('a well-formed felt is accepted and canonicalised', () => {
  assert.equal(normalisePoolAddress('0x0001'), '0x1');
  assert.equal(normalisePoolAddress('  ' + MAIN + '  '), MAIN);
});

await test('anything that is not a Starknet address is refused', () => {
  for (const bad of ['', 'nonsense', '0x', '0xZZ', MAIN + 'ff', '12808521', '0x0']) {
    assert.equal(normalisePoolAddress(bad), undefined, `accepted "${bad}"`);
  }
});

await test('a zero address is refused rather than read as the default', () => {
  // Zero on the wire MEANS "use the gateway's default", so accepting it here
  // would silently send to the main pool while the UI showed a custom one.
  assert.equal(normalisePoolAddress('0x0'), undefined);
  assert.equal(normalisePoolAddress('0x000'), undefined);
});

// ── the check ────────────────────────────────────────────────────────────────

await test('a factory-registered pool that carries the asset is usable', async () => {
  const r = await checkPool(asset(), OWN, opts());
  assert.equal(r.ok, true);
  assert.equal(r.pool, OWN);
  assert.equal(r.isMain, false);
});

await test('the main pool is recognised as the main pool', async () => {
  const r = await checkPool(asset(), MAIN, opts());
  assert.equal(r.ok, true);
  assert.equal(r.isMain, true);
});

await test('an address the factory never made is refused', async () => {
  const r = await checkPool(asset(), '0xdeadbeef', opts());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-pool');
});

await test('a real pool that does not carry this asset is refused', async () => {
  // Multi-asset is not every-asset: a pool holds what its owner allow-listed.
  const r = await checkPool(asset(), OWN, opts({ carries: [] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong-asset');
});

await test('a contract that is not a pool at all is refused', async () => {
  // Registered by a hostile factory answer, but has no is_token_allowed.
  const r = await checkPool(asset(), OWN, opts({ poolThrows: true }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-pool');
});

await test('an unreachable RPC is reported as such, not as a bad address', async () => {
  const r = await checkPool(asset(), OWN, opts({ factoryThrows: true }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
});

await test('a malformed address never reaches the chain', async () => {
  const r = await checkPool(asset(), 'not an address', {
    read: () => { throw new Error('should not have been called'); },
    factory: FACTORY,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

await test('a genuine pool the mirror has not registered is refused', async () => {
  // The pool PULLS the tokens and the twin asserts is_verified(to). A pool can
  // be factory-genuine and carry the asset and still not be able to hold it.
  const r = await checkPool(asset(), OWN, opts({ holders: [MAIN] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-holder');
});

await test('every problem has something to show the user', () => {
  for (const key of ['malformed', 'no-factory', 'not-a-pool', 'wrong-asset',
                     'not-a-holder', 'unreachable']) {
    assert.ok(POOL_PROBLEMS[key] && POOL_PROBLEMS[key].length > 10, `no message for ${key}`);
  }
});

console.log(`\n${passed} passed`);
