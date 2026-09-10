// The deployable ERC-3643 faucet assets, as they will exist on Ethereum Sepolia.
//
// These are not mocks: this is the token the bridge is pointed at on testnet,
// so its gate has to be the real one. What matters here is that a permissioned
// asset behaves like one -- an unverified holder cannot receive, a frozen one
// cannot move, compliance can refuse -- and that the lockbox can escrow from it
// once the issuer has registered the lockbox.
//
// The faucet itself is the only testnet-shaped part, and it is the part most
// likely to be abused: it registers whoever calls it. Its limits are tested
// here for that reason.

const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const OWNER = 1;
const ALICE = 2;
const BOB = 3;
const MALLORY = 5;

const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const UNITS = (n) => ethers.parseUnits(String(n), 18);

async function setup({ withModules = false, faucet = UNITS(1000) } = {}) {
  const chain = await Chain_.create();
  const registry = await chain.deploy('FaucetIdentityRegistry', [addr(OWNER)]);
  const compliance = await chain.deploy('FaucetCompliance', [addr(OWNER)]);
  const token = await chain.deploy('FaucetERC3643', [
    'Tokenized Gold', 'XAU', addr(OWNER), registry.hex, compliance.hex,
  ]);

  // The token registers claimants, so it must be an agent on the registry.
  await registry.call('addAgent', [token.hex], OWNER);
  await compliance.call('bindToken', [token.hex], OWNER);
  await token.call('configureFaucet', [faucet, 840, 0], OWNER);

  const modules = {};
  if (withModules) {
    for (const [key, name] of [
      ['countryAllow', 'CountryAllowModule'],
      ['countryRestrict', 'CountryRestrictModule'],
      ['transferRestrict', 'TransferRestrictModule'],
      ['supplyLimit', 'SupplyLimitModule'],
      ['maxBalance', 'MaxBalanceModule'],
    ]) {
      modules[key] = await chain.deploy(name, [addr(OWNER)]);
      await compliance.call('addModule', [modules[key].hex], OWNER);
    }
  }
  return { chain, registry, compliance, token, modules };
}

// ── The faucet ───────────────────────────────────────────────────────────────

test('claiming registers the caller and mints to them', async () => {
  const { registry, token } = await setup();
  eq((await registry.call('isVerified', [addr(ALICE)])).decoded[0], false, 'starts unverified');

  succeeds(await token.call('claim', [], ALICE), 'claim');

  eq((await registry.call('isVerified', [addr(ALICE)])).decoded[0], true, 'registered');
  eq((await registry.call('investorCountry', [addr(ALICE)])).decoded[0], 840n, 'country');
  eq((await token.call('balanceOf', [addr(ALICE)])).decoded[0], UNITS(1000), 'minted');
});

test('a cooldown holds a repeat claim', async () => {
  const { token } = await setup();
  await token.call('configureFaucet', [UNITS(1000), 840, 3600], OWNER);
  succeeds(await token.call('claim', [], ALICE), 'first claim');
  reverts(await token.call('claim', [], ALICE), 'FaucetCooldown');
});

test('a faucet amount of zero disables claiming', async () => {
  const { token } = await setup({ faucet: 0n });
  reverts(await token.call('claim', [], ALICE), 'FaucetDisabled');
});

test('only the owner configures the faucet', async () => {
  const { token } = await setup();
  reverts(await token.call('configureFaucet', [UNITS(1), 840, 0], MALLORY), 'NotOwner');
});

test('the faucet cannot mint while the token is paused', async () => {
  const { token } = await setup();
  await token.call('setPaused', [true], OWNER);
  reverts(await token.call('claim', [], ALICE), 'TokenPaused');
});

// ── The permission gate ──────────────────────────────────────────────────────

test('an unverified recipient cannot receive', async () => {
  const { token } = await setup();
  await token.call('claim', [], ALICE);
  // BOB never claimed, so he is not registered.
  reverts(await token.call('transfer', [addr(BOB), UNITS(1)], ALICE), 'RecipientNotVerified');
});

test('a verified holder can transfer to another verified holder', async () => {
  const { token } = await setup();
  await token.call('claim', [], ALICE);
  await token.call('claim', [], BOB);
  succeeds(await token.call('transfer', [addr(BOB), UNITS(250)], ALICE), 'transfer');
  eq((await token.call('balanceOf', [addr(ALICE)])).decoded[0], UNITS(750), 'sender');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], UNITS(1250), 'recipient');
});

test('a revoked holder can no longer move value', async () => {
  const { registry, token } = await setup();
  await token.call('claim', [], ALICE);
  await token.call('claim', [], BOB);
  await registry.call('deleteIdentity', [addr(ALICE)], OWNER);
  reverts(await token.call('transfer', [addr(BOB), UNITS(1)], ALICE), 'SenderNotVerified');
});

test('a frozen address is stopped in both directions', async () => {
  const { token } = await setup();
  await token.call('claim', [], ALICE);
  await token.call('claim', [], BOB);
  await token.call('setAddressFrozen', [addr(ALICE), true], OWNER);
  reverts(await token.call('transfer', [addr(BOB), UNITS(1)], ALICE), 'SenderFrozen');
  await token.call('setAddressFrozen', [addr(ALICE), false], OWNER);
  await token.call('setAddressFrozen', [addr(BOB), true], OWNER);
  reverts(await token.call('transfer', [addr(BOB), UNITS(1)], ALICE), 'RecipientFrozen');
});

test('pausing stops every transfer', async () => {
  const { token } = await setup();
  await token.call('claim', [], ALICE);
  await token.call('claim', [], BOB);
  await token.call('setPaused', [true], OWNER);
  reverts(await token.call('transfer', [addr(BOB), UNITS(1)], ALICE), 'TokenPaused');
});

test('mallory cannot mint, freeze, pause or seize', async () => {
  const { token } = await setup();
  await token.call('claim', [], ALICE);
  reverts(await token.call('mint', [addr(MALLORY), UNITS(1)], MALLORY), 'NotAgent');
  reverts(await token.call('setAddressFrozen', [addr(ALICE), true], MALLORY), 'NotAgent');
  reverts(await token.call('setPaused', [true], MALLORY), 'NotAgent');
  reverts(
    await token.call('forcedTransfer', [addr(ALICE), addr(MALLORY), UNITS(1)], MALLORY),
    'NotAgent'
  );
});

test('mallory cannot register herself on the registry', async () => {
  const { registry } = await setup();
  reverts(await registry.call('registerIdentity', [addr(MALLORY), 840], MALLORY), 'NotAgent');
});

test('the agent can seize a balance, as T-REX recovery does', async () => {
  const { token } = await setup();
  await token.call('claim', [], ALICE);
  await token.call('claim', [], BOB);
  succeeds(
    await token.call('forcedTransfer', [addr(ALICE), addr(BOB), UNITS(1000)], OWNER),
    'forcedTransfer'
  );
  eq((await token.call('balanceOf', [addr(ALICE)])).decoded[0], 0n, 'seized');
});

// ── Compliance modules ───────────────────────────────────────────────────────

test('an unconfigured module set does not block anything', async () => {
  // A module bound with nothing configured must not brick the token.
  const { token } = await setup({ withModules: true });
  succeeds(await token.call('claim', [], ALICE), 'claim with modules bound');
});

test('a country allow-list stops a holder from a country not on it', async () => {
  const { token, compliance, modules } = await setup({ withModules: true });
  await modules.countryAllow.call('addAllowedCountry', [compliance.hex, 76], OWNER);
  // The faucet registers claimants as 840, which is not allowed.
  reverts(await token.call('claim', [], ALICE), 'ComplianceBlocked');
});

test('a restricted country is refused', async () => {
  const { token, compliance, modules } = await setup({ withModules: true });
  await modules.countryRestrict.call('addCountryRestriction', [compliance.hex, 840], OWNER);
  reverts(await token.call('claim', [], ALICE), 'ComplianceBlocked');
});

test('a supply limit caps minting', async () => {
  const { token, compliance, modules } = await setup({ withModules: true });
  await modules.supplyLimit.call('setSupplyLimit', [compliance.hex, UNITS(1500)], OWNER);
  succeeds(await token.call('claim', [], ALICE), 'first claim under the limit');
  reverts(await token.call('claim', [], BOB), 'ComplianceBlocked');
});

test('a max balance caps a holder', async () => {
  const { token, compliance, modules } = await setup({ withModules: true });
  await modules.maxBalance.call('setMaxBalance', [compliance.hex, UNITS(500)], OWNER);
  reverts(await token.call('claim', [], ALICE), 'ComplianceBlocked');
});

test('the max balance ledger tracks transfers', async () => {
  const { token, compliance, modules } = await setup({ withModules: true });
  await modules.maxBalance.call('setMaxBalance', [compliance.hex, UNITS(1000)], OWNER);
  await token.call('claim', [], ALICE);
  await token.call('claim', [], BOB);
  // Both hold exactly the cap, so any transfer between them breaches it.
  reverts(await token.call('transfer', [addr(BOB), UNITS(1)], ALICE), 'ComplianceBlocked');
  eq(
    (await modules.maxBalance.call('getIDBalance', [compliance.hex, addr(ALICE)])).decoded[0],
    UNITS(1000), 'ledger'
  );
});

test('a compliance module that reverts refuses the transfer', async () => {
  // Failing OPEN is the one direction compliance must never fail.
  const { chain, token, compliance } = await setup({ withModules: false });
  const hostile = await chain.deploy('MockHostileModule');
  await compliance.call('addModule', [hostile.hex], OWNER);
  reverts(await token.call('claim', [], ALICE), 'ComplianceBlocked');
});

test('only the bound token may report movements', async () => {
  const { compliance } = await setup({ withModules: true });
  reverts(await compliance.call('transferred', [addr(ALICE), addr(BOB), 1n], MALLORY), 'NotToken');
});

// ── What the export tool reads ───────────────────────────────────────────────

test('the reader sees the modules and their names', async () => {
  const { chain, compliance } = await setup({ withModules: true });
  const reader = await chain.deploy('ComplianceReader');
  const res = await reader.call('readModules', [compliance.hex]);
  const names = res.decoded[1];
  ok(names.includes('CountryAllowModule'), 'CountryAllowModule');
  ok(names.includes('MaxBalanceModule'), 'MaxBalanceModule');
  ok(names.includes('SupplyLimitModule'), 'SupplyLimitModule');
  eq(names.length, 5, 'five modules');
});

test('the reader reads the token wiring', async () => {
  const { chain, token, compliance, registry } = await setup();
  const reader = await chain.deploy('ComplianceReader');
  const info = (await reader.call('readToken', [token.hex])).decoded[0];
  eq(info[0].toLowerCase(), compliance.hex.toLowerCase(), 'compliance');
  eq(info[1].toLowerCase(), registry.hex.toLowerCase(), 'identityRegistry');
  eq(info[2], false, 'not paused');
});

test('the max balance is recoverable only from its event, as upstream', async () => {
  // MaxBalanceModule deliberately exposes no getter for the cap, because the
  // export tool's event-reconstruction path has to be exercised against it.
  const { chain, compliance, modules } = await setup({ withModules: true });
  succeeds(
    await modules.maxBalance.call('setMaxBalance', [compliance.hex, UNITS(777)], OWNER),
    'setMaxBalance'
  );
  const log = chain.logs.find(
    (l) => l.address.toLowerCase() === modules.maxBalance.hex.toLowerCase()
      && l.topics.length === 3
  );
  ok(log !== undefined, 'MaxBalanceSet emitted with two indexed args');
  eq(BigInt(log.topics[2]), UNITS(777), 'the cap is only in the event');
});

// ── The lockbox against a real faucet token ──────────────────────────────────

test('the lockbox can escrow once the issuer registers it', async () => {
  const { chain, registry, token } = await setup();
  const endpoint = await chain.deploy('MockEndpoint');
  const lockbox = await chain.deploy('VeilERC3643Lockbox', [
    endpoint.hex, addr(OWNER), token.hex, 40500,
  ]);
  await lockbox.call('setPeer', [40500, '0x' + '11'.repeat(32)], OWNER);
  await token.call('claim', [], ALICE);
  await token.call('approve', [lockbox.hex, UNITS(1000)], ALICE);

  // Unregistered, the escrow fails inside the token: the lockbox is the
  // RECIPIENT of the transfer, and T-REX verifies recipients.
  reverts(
    await lockbox.call(
      'bridgeOut',
      [UNITS(10), '0x' + '22'.repeat(32), '0x' + 'ab'.repeat(32), '0x' + '00'.repeat(32),
       200000n, addr(ALICE)],
      ALICE
    ),
    // The token's own error, raised through the lockbox. Matched by selector
    // because the harness decodes against the CALLED contract's ABI, and this
    // error belongs to the token.
    '0xec785f9a'
  );

  await registry.call('registerIdentity', [lockbox.hex, 840], OWNER);
  succeeds(
    await lockbox.call(
      'bridgeOut',
      [UNITS(10), '0x' + '22'.repeat(32), '0x' + 'ab'.repeat(32), '0x' + '00'.repeat(32),
       200000n, addr(ALICE)],
      ALICE
    ),
    'bridgeOut after registration'
  );
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], UNITS(10), 'escrowed');
});

// ── The router: one transaction for every asset ──────────────────────────────

async function multiAsset(chain, registry, count = 3) {
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const compliance = await chain.deploy('FaucetCompliance', [addr(OWNER)]);
    const token = await chain.deploy('FaucetERC3643', [
      `Asset ${i}`, `A${i}`, addr(OWNER), registry.hex, compliance.hex,
    ]);
    await registry.call('addAgent', [token.hex], OWNER);
    await compliance.call('bindToken', [token.hex], OWNER);
    await token.call('configureFaucet', [UNITS(1000), 840, 0], OWNER);
    tokens.push(token);
  }
  return tokens;
}

test('claimFor credits the recipient, not the caller', async () => {
  const { token } = await setup();
  succeeds(await token.call('claimFor', [addr(BOB)], ALICE), 'claimFor');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], UNITS(1000), 'recipient paid');
  eq((await token.call('balanceOf', [addr(ALICE)])).decoded[0], 0n, 'caller not paid');
});

test('the cooldown follows the recipient, not the caller', async () => {
  // Otherwise claiming through the router would bypass it.
  const { token } = await setup();
  await token.call('configureFaucet', [UNITS(1000), 840, 3600], OWNER);
  succeeds(await token.call('claimFor', [addr(BOB)], ALICE), 'first');
  reverts(await token.call('claimFor', [addr(BOB)], MALLORY), 'FaucetCooldown');
});

test('the router stocks every asset in one call', async () => {
  const chain = await Chain_.create();
  const registry = await chain.deploy('FaucetIdentityRegistry', [addr(OWNER)]);
  const tokens = await multiAsset(chain, registry);
  const router = await chain.deploy('FaucetRouter');

  const res = await router.call('claimAll', [tokens.map((t) => t.hex), addr(ALICE)], ALICE);
  succeeds(res, 'claimAll');
  eq(res.decoded[0], 3n, 'all three claimed');
  for (const t of tokens) {
    eq((await t.call('balanceOf', [addr(ALICE)])).decoded[0], UNITS(1000), 'balance');
  }
});

test('one asset on cooldown does not deny the others', async () => {
  // The second visit: without skipping, a single cooled-down asset would revert
  // the whole batch and the tester would get nothing.
  const chain = await Chain_.create();
  const registry = await chain.deploy('FaucetIdentityRegistry', [addr(OWNER)]);
  const tokens = await multiAsset(chain, registry);
  const router = await chain.deploy('FaucetRouter');

  await tokens[0].call('configureFaucet', [UNITS(1000), 840, 3600], OWNER);
  await tokens[0].call('claimFor', [addr(ALICE)], ALICE);   // now on cooldown

  const res = await router.call('claimAll', [tokens.map((t) => t.hex), addr(ALICE)], ALICE);
  succeeds(res, 'claimAll with one refusing');
  eq(res.decoded[0], 2n, 'the other two still claimed');
  eq((await tokens[1].call('balanceOf', [addr(ALICE)])).decoded[0], UNITS(1000), 'second');
  eq((await tokens[2].call('balanceOf', [addr(ALICE)])).decoded[0], UNITS(1000), 'third');
});

test('the router keeps nothing for itself', async () => {
  const chain = await Chain_.create();
  const registry = await chain.deploy('FaucetIdentityRegistry', [addr(OWNER)]);
  const tokens = await multiAsset(chain, registry, 2);
  const router = await chain.deploy('FaucetRouter');
  await router.call('claimAll', [tokens.map((t) => t.hex), addr(ALICE)], ALICE);
  for (const t of tokens) {
    eq((await t.call('balanceOf', [router.hex])).decoded[0], 0n, 'router holds nothing');
  }
});

test('a non-faucet address in the list is skipped, not fatal', async () => {
  const chain = await Chain_.create();
  const registry = await chain.deploy('FaucetIdentityRegistry', [addr(OWNER)]);
  const tokens = await multiAsset(chain, registry, 2);
  const router = await chain.deploy('FaucetRouter');
  const list = [tokens[0].hex, addr(0xdead), tokens[1].hex];
  const res = await router.call('claimAll', [list, addr(ALICE)], ALICE);
  succeeds(res, 'claimAll with a bogus entry');
  eq(res.decoded[0], 2n, 'the two real ones claimed');
});

run('faucet: deployable ERC-3643 assets for Ethereum Sepolia');
