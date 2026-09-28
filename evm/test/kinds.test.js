// The two permissioned ERC-20 kinds the bridge carries besides ERC-3643:
//
//   - an ALLOWLISTED ERC-20 (`VeilAllowlistLockbox`): eligibility is the
//     issuer's allowlist, read through `hasRole(role, account)`;
//   - a RULE-GATED ERC-20 (`VeilRulesLockbox`): eligibility and the issuer's
//     transfer rules come from an `IVeilRulesSource` adapter, and the rules
//     themselves are sent to Starknet (HOLDER_RULES, TOKEN_RULES).
//
// Each runs against a token whose own transfer check is the real one for its
// kind (faucet/FaucetAllowlist.sol, faucet/FaucetRules.sol), with LayerZero
// replaced by the recording endpoint. The wire vectors at the top are pinned
// byte for byte on the Cairo side too (tests/test_rules.cairo).

const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const OWNER = 1;
const ALICE = 2;
const BOB = 3;
const MALLORY = 5;
const REFUND = 6;
const NOTE = '0x' + 'ab'.repeat(32);
const DST_EID = 30500;
const PEER = '0x' + BigInt('0xdeadbeef').toString(16).padStart(64, '0');
const GAS = 80_000_000n;

const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const B32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const WHITELISTED = ethers.id('WHITELISTED_ROLE');
/// A revert raised inside the TOKEN bubbles through the lockbox as the token's
/// own error, which the lockbox's ABI cannot name: match its selector.
const sel = (sig) => ethers.id(sig).slice(0, 10);

async function lastMessage(endpoint) {
  return (await endpoint.call('lastMessage')).decoded[0];
}

async function deliverUnlock(endpoint, lockbox, recipient, amount, nonce = 1) {
  const msg = ethers.solidityPacked(['uint8', 'bytes32', 'uint256'], [4, B32(BigInt(recipient)), amount]);
  return endpoint.call('deliver', [lockbox.hex, DST_EID, PEER, nonce, msg]);
}

// ------------------------------------------------------------- wire format

test('HOLDER_RULES encoding: the layout pinned on the Cairo side', async () => {
  const chain = await Chain_.create();
  const codec = await chain.deploy('CodecHarness');
  const res = await codec.call('encodeHolderRules', [addr(0xb0b), 7n, true, false, true, 42n]);
  succeeds(res, 'encode');
  const bytes = res.decoded[0];
  eq(bytes, ethers.solidityPacked(
    ['uint8', 'bytes32', 'uint64', 'bool', 'bool', 'bool', 'uint256'],
    [5, B32(0xb0b), 7n, true, false, true, 42n]), 'packed');
  eq((bytes.length - 2) / 2, 76, 'length');
  // The exact vector the Cairo test decodes.
  eq(bytes, '0x05' + B32(0xb0b).slice(2) + '0000000000000007' + '01' + '00' + '01' + B32(42).slice(2), 'vector');
  const d = (await codec.call('decodeHolderRules', [bytes])).decoded;
  eq(d[0].toLowerCase(), addr(0xb0b), 'account'); eq(d[1], 7n, 'seq');
  eq(d[2], true, 'canHold'); eq(d[3], false, 'frozen'); eq(d[4], true, 'isInvestor'); eq(d[5], 42n, 'locked');
});

test('TOKEN_RULES encoding: the layout pinned on the Cairo side', async () => {
  const chain = await Chain_.create();
  const codec = await chain.deploy('CodecHarness');
  const res = await codec.call('encodeTokenRules', [3n, true, false, true, false, 1000n]);
  succeeds(res, 'encode');
  const bytes = res.decoded[0];
  eq((bytes.length - 2) / 2, 45, 'length');
  eq(bytes, '0x06' + '0000000000000003' + '01' + '00' + '01' + '00' + B32(1000).slice(2), 'vector');
  const d = (await codec.call('decodeTokenRules', [bytes])).decoded;
  eq(d[0], 3n, 'seq'); eq(d[1], true, 'enabled'); eq(d[2], false, 'cap'); eq(d[3], true, 'full');
  eq(d[4], false, 'strict'); eq(d[5], 1000n, 'min');
});

test('a truncated or mislabelled rules message is refused', async () => {
  const chain = await Chain_.create();
  const codec = await chain.deploy('CodecHarness');
  reverts(await codec.call('decodeHolderRules', ['0x05' + '00'.repeat(74)]), 'BadLength', 'short');
  reverts(await codec.call('decodeTokenRules', ['0x05' + '00'.repeat(44)]), 'BadKind', 'wrong kind');
});

// ------------------------------------------------------------- allowlisted

async function allowlistSetup({ allowLockbox = true } = {}) {
  const chain = await Chain_.create();
  const manager = await chain.deploy('FaucetPermissionManager', [addr(OWNER)]);
  const token = await chain.deploy('FaucetAllowlistToken', ['Allowlisted Fund', 'ALF', addr(OWNER), manager.hex]);
  await manager.call('addAgent', [token.hex]);
  const endpoint = await chain.deploy('MockEndpoint');
  const lockbox = await chain.deploy('VeilAllowlistLockbox', [
    endpoint.hex, addr(OWNER), token.hex, DST_EID, manager.hex, WHITELISTED,
  ]);
  await lockbox.call('setPeer', [DST_EID, PEER]);
  for (const who of [ALICE, BOB]) await manager.call('grantRole', [WHITELISTED, addr(who)]);
  if (allowLockbox) await manager.call('grantRole', [WHITELISTED, lockbox.hex]);
  await token.call('mint', [addr(ALICE), 1_000_000n]);
  await token.call('approve', [lockbox.hex, 1_000_000n], ALICE);
  return { chain, manager, token, endpoint, lockbox };
}

test('allowlisted: an allowed holder bridges; the snapshot says allowed, no country', async () => {
  const { chain, endpoint, lockbox, token } = await allowlistSetup();
  succeeds(await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), 'bridgeOut');
  const codec = await chain.deploy('CodecHarness');
  const m = (await codec.call('decodeMint', [await lastMessage(endpoint)])).decoded;
  eq(m[0].toLowerCase(), addr(ALICE), 'sender'); eq(m[2], 1000n, 'amount');
  eq(m[4], true, 'verified'); eq(m[5], false, 'frozen'); eq(m[6], 0n, 'no country');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1000n, 'escrowed');
});

test('allowlisted: a holder off the list cannot bridge', async () => {
  const { lockbox, manager, token } = await allowlistSetup();
  await manager.call('revokeRole', [WHITELISTED, addr(ALICE)]);
  reverts(await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), 'NotVerified', 'revoked');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 0n, 'nothing escrowed');
});

test('allowlisted: without the lockbox on the list the token refuses the escrow', async () => {
  const { lockbox } = await allowlistSetup({ allowLockbox: false });
  reverts(await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), sel('RecipientNotAllowed()'), 'lockbox not allowed');
});

test('allowlisted: syncCompliance forwards list membership as it is now', async () => {
  const { endpoint, lockbox, manager } = await allowlistSetup();
  succeeds(await lockbox.call('syncCompliance', [addr(BOB), GAS, addr(REFUND)], MALLORY), 'sync');
  const id = ethers.getBytes(await lastMessage(endpoint));
  eq(id[0], 2, 'IDENTITY'); eq(id[41], 1, 'verified');
  await manager.call('revokeRole', [WHITELISTED, addr(BOB)]);
  succeeds(await lockbox.call('syncCompliance', [addr(BOB), GAS, addr(REFUND)], MALLORY), 'sync again');
  eq(ethers.getBytes(await lastMessage(endpoint))[41], 0, 'no longer verified');
});

test('allowlisted: syncGlobal reads the token pause', async () => {
  const { endpoint, lockbox, token } = await allowlistSetup();
  await token.call('setPaused', [true]);
  succeeds(await lockbox.call('syncGlobal', [GAS, addr(REFUND)], MALLORY), 'global');
  const g = ethers.getBytes(await lastMessage(endpoint));
  eq(g[0], 3, 'GLOBAL'); eq(g[9], 1, 'paused');
});

test('allowlisted: a release reaches an allowed wallet, is held for one off the list, and claims later', async () => {
  const { endpoint, lockbox, manager, token } = await allowlistSetup();
  await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE);
  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 400n, 1), 'unlock');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'released');
  await manager.call('revokeRole', [WHITELISTED, addr(BOB)]);
  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 100n, 2), 'unlock held');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 100n, 'held');
  reverts(await lockbox.call('claim', [addr(BOB)], MALLORY), 'StillIneligible', 'still off the list');
  await manager.call('grantRole', [WHITELISTED, addr(BOB)]);
  succeeds(await lockbox.call('claim', [addr(BOB)], MALLORY), 'claim');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 500n, 'claimed');
});

// ------------------------------------------------------------- rule-gated

async function rulesSetup() {
  const chain = await Chain_.create();
  const source = await chain.deploy('FaucetRulesSource', [addr(OWNER)]);
  const token = await chain.deploy('FaucetRulesToken', ['Rule-gated Fund', 'RGF', addr(OWNER), source.hex]);
  await source.call('addAgent', [token.hex]);
  await source.call('setToken', [token.hex]);
  const endpoint = await chain.deploy('MockEndpoint');
  const lockbox = await chain.deploy('VeilRulesLockbox', [endpoint.hex, addr(OWNER), token.hex, DST_EID, source.hex]);
  await lockbox.call('setPeer', [DST_EID, PEER]);
  // The issuer admits the lockbox as a platform wallet, and its investors.
  await source.call('setPlatform', [lockbox.hex, true]);
  await source.call('setHolder', [addr(ALICE), true, false, true, 0n]);
  await source.call('setHolder', [addr(BOB), true, false, true, 0n]);
  await token.call('mint', [addr(ALICE), 1_000_000n]);
  await token.call('approve', [lockbox.hex, 1_000_000n], ALICE);
  const codec = await chain.deploy('CodecHarness');
  return { chain, source, token, endpoint, lockbox, codec };
}

test('rule-gated: an investor bridges; a holder who may not hold cannot', async () => {
  const { endpoint, lockbox, source, codec } = await rulesSetup();
  succeeds(await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), 'bridgeOut');
  const m = (await codec.call('decodeMint', [await lastMessage(endpoint)])).decoded;
  eq(m[4], true, 'verified'); eq(m[5], false, 'frozen');
  await source.call('setHolder', [addr(ALICE), false, false, true, 0n]);
  reverts(await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), 'NotVerified', 'cannot hold');
});

test('rule-gated: locked tokens do not leave through the bridge', async () => {
  const { lockbox, source, token } = await rulesSetup();
  await source.call('setHolder', [addr(ALICE), true, false, true, 999_500n]);
  reverts(await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), sel('TokensLocked()'), 'locked');
  succeeds(await lockbox.call('bridgeOut', [500n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE), 'the free part');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 500n, 'escrowed');
});

test('rule-gated: syncRules carries the holder rules, with the lock this chain does not cover', async () => {
  const { endpoint, lockbox, source, codec } = await rulesSetup();
  // Alice holds 1,000,000 here; a lock of 1,000,250 leaves 250 to keep in Veil.
  await source.call('setHolder', [addr(ALICE), true, false, true, 1_000_250n]);
  succeeds(await lockbox.call('syncRules', [addr(ALICE), GAS, addr(REFUND)], MALLORY), 'syncRules');
  const r = (await codec.call('decodeHolderRules', [await lastMessage(endpoint)])).decoded;
  eq(r[0].toLowerCase(), addr(ALICE), 'account'); eq(r[2], true, 'canHold'); eq(r[3], false, 'frozen');
  eq(r[4], true, 'isInvestor'); eq(r[5], 250n, 'locked beyond this chain');
});

test('rule-gated: syncTokenRules carries the token rules; the sequence keeps rising', async () => {
  const { endpoint, lockbox, source, codec } = await rulesSetup();
  await source.call('setTokenRules', [[true, true, false, 5000n, true]]);
  succeeds(await lockbox.call('syncTokenRules', [GAS, addr(REFUND)], MALLORY), 'first');
  const a = (await codec.call('decodeTokenRules', [await lastMessage(endpoint)])).decoded;
  eq(a[1], true, 'enabled'); eq(a[2], true, 'cap reached'); eq(a[3], false, 'full'); eq(a[4], true, 'strict'); eq(a[5], 5000n, 'min');
  succeeds(await lockbox.call('syncGlobal', [GAS, addr(REFUND)], MALLORY), 'global');
  succeeds(await lockbox.call('syncTokenRules', [GAS, addr(REFUND)], MALLORY), 'second');
  const b = (await codec.call('decodeTokenRules', [await lastMessage(endpoint)])).decoded;
  ok(b[0] > a[0], 'strictly increasing across token-level messages');
});

test('rule-gated: frozen and pause come from the issuer rules', async () => {
  const { endpoint, lockbox, source } = await rulesSetup();
  await source.call('setHolder', [addr(BOB), true, true, true, 0n]);
  await lockbox.call('syncCompliance', [addr(BOB), GAS, addr(REFUND)], MALLORY);
  const id = ethers.getBytes(await lastMessage(endpoint));
  eq(id[41], 1, 'verified'); eq(id[42], 1, 'frozen');
  await source.call('setPaused', [true]);
  await lockbox.call('syncGlobal', [GAS, addr(REFUND)], MALLORY);
  eq(ethers.getBytes(await lastMessage(endpoint))[9], 1, 'paused');
});

test('rule-gated: the quotes price the rules messages', async () => {
  const { endpoint, lockbox } = await rulesSetup();
  await endpoint.call('setFee', [777n]);
  eq((await lockbox.call('quoteSyncRules', [addr(ALICE), GAS])).decoded[0].nativeFee, 777n, 'holder rules');
  eq((await lockbox.call('quoteSyncTokenRules', [GAS])).decoded[0].nativeFee, 777n, 'token rules');
});

test('rule-gated: a release to a holder who may no longer hold is held, then claimed', async () => {
  const { endpoint, lockbox, source, token } = await rulesSetup();
  await lockbox.call('bridgeOut', [1000n, B32(addr(ALICE)), NOTE, B32(0), GAS, addr(REFUND)], ALICE);
  await source.call('setHolder', [addr(BOB), false, false, false, 0n]);
  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 300n, 1), 'unlock');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 300n, 'held');
  await source.call('setHolder', [addr(BOB), true, false, true, 0n]);
  succeeds(await lockbox.call('claim', [addr(BOB)], MALLORY), 'claim');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 300n, 'arrived');
});

test("rule-gated: the token's own check applies the rules the pool will prove", async () => {
  const { token, source } = await rulesSetup();
  // Full balance required between investors.
  await source.call('setTokenRules', [[true, false, true, 0n, false]]);
  reverts(await token.call('transfer', [addr(BOB), 10n], ALICE), 'FullBalanceRequired', 'full');
  // Minimum holding on a partial transfer.
  await source.call('setTokenRules', [[true, false, false, 999_995n, false]]);
  reverts(await token.call('transfer', [addr(BOB), 10n], ALICE), 'BelowMinHolding', 'min holding');
  // Investor cap: a new investor only when the sender exits.
  await source.call('setTokenRules', [[true, true, false, 0n, false]]);
  await source.call('setHolder', [addr(MALLORY), true, false, false, 0n]);
  reverts(await token.call('transfer', [addr(MALLORY), 10n], ALICE), 'InvestorCapReached', 'cap');
  succeeds(await token.call('transfer', [addr(BOB), 10n], ALICE), 'to an existing investor');
  // Transfers switched off.
  await source.call('setTokenRules', [[false, false, false, 0n, false]]);
  reverts(await token.call('transfer', [addr(BOB), 10n], ALICE), 'TransfersDisabled', 'switch');
});

run();
