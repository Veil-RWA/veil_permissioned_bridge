// Adversarial tests for the EVM half of the LayerZero ERC-3643 bridge.
//
// Scope: what the lockbox enforces on its own, with LayerZero replaced by a
// mock endpoint that records outbound messages and can drive inbound ones. The
// Starknet half is covered by tests/test_bridge.cairo.
//
// The wire-format tests here and the layout tests there assert the SAME
// vectors from opposite sides. That is the point: the two codecs are written in
// different languages against one spec, and a change to either that is not
// mirrored breaks a test rather than a testnet deployment.

const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const OWNER = 1;
const ALICE = 2;
const BOB = 3;
const MALLORY = 5;
const REFUND = 6;

const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const B32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
/// A revert raised inside the lockbox but delivered through the mock endpoint
/// comes back as raw data -- the endpoint's ABI has no name for the lockbox's
/// errors -- so those assertions match on the selector instead.
const sel = (sig) => ethers.id(sig).slice(0, 10);

// Endpoint ids: Ethereum mainnet -> Starknet mainnet.
const SRC_EID = 30101;
const DST_EID = 30500;
// The Starknet gateway, as LayerZero's 32-byte address word.
const PEER = B32('0xdeadbeef');

/// A fully wired lockbox: registry, compliance, token, endpoint, peer set, and
/// the lockbox registered as a verified identity -- without that last step no
/// escrow can succeed, because T-REX verifies the recipient of every transfer.
async function setup({ registerLockbox = true } = {}) {
  const chain = await Chain_.create();
  const registry = await chain.deploy('MockIdentityRegistry');
  const compliance = await chain.deploy('MockCompliance');
  const token = await chain.deploy('MockERC3643Token', [registry.hex, compliance.hex]);
  const endpoint = await chain.deploy('MockEndpoint');
  const lockbox = await chain.deploy('VeilERC3643Lockbox', [
    endpoint.hex,
    addr(OWNER),
    token.hex,
    DST_EID,
  ]);

  await lockbox.call('setPeer', [DST_EID, PEER], OWNER);
  await registry.call('setVerified', [addr(ALICE), true]);
  await registry.call('setCountry', [addr(ALICE), 840]);
  await registry.call('setVerified', [addr(BOB), true]);
  if (registerLockbox) await registry.call('setVerified', [lockbox.hex, true]);

  await token.call('mint', [addr(ALICE), 1_000_000n]);
  await token.call('approve', [lockbox.hex, 1_000_000n], ALICE);

  return { chain, registry, compliance, token, endpoint, lockbox };
}

const unlockMsg = (recipient, amount) =>
  ethers.solidityPacked(['uint8', 'bytes32', 'uint256'], [4, B32(BigInt(recipient)), amount]);

async function deliverUnlock(endpoint, lockbox, recipient, amount, nonce = 1) {
  return endpoint.call('deliver', [
    lockbox.hex,
    DST_EID,
    PEER,
    nonce,
    unlockMsg(recipient, amount),
  ]);
}

// ------------------------------------------------------------- wire format

test('MINT encoding matches the layout pinned on the Cairo side', async () => {
  const { chain } = await setup();
  const codec = await chain.deploy('CodecHarness');

  // The same vector asserted byte-by-byte in tests/test_bridge.cairo:
  // evm sender 0xA11CE, recipient felt 101, 1000 units, seq 7, verified,
  // not frozen, country 840.
  const res = await codec.call('encodeMint', [
    '0x00000000000000000000000000000000000a11ce',
    B32(101),
    1000n,
    7n,
    true,
    false,
    840,
    0,
    B32(0),
  ]);
  succeeds(res, 'encodeMint');
  const bytes = res.decoded[0];
  const expected = ethers.solidityPacked(
    ['uint8', 'bytes32', 'bytes32', 'uint256', 'uint64', 'bool', 'bool', 'uint16', 'uint8', 'bytes32'],
    [1, B32('0xa11ce'), B32(101), 1000n, 7n, true, false, 840, 0, B32(0)]
  );
  eq(bytes, expected, 'packed bytes');
  eq((bytes.length - 2) / 2, 142, 'MINT length');

  // The exact byte offsets the Cairo test reads.
  const b = ethers.getBytes(bytes);
  eq(b[0], 1, 'kind');
  eq(b[30], 0x0a, 'evm byte 0');
  eq(b[31], 0x11, 'evm byte 1');
  eq(b[32], 0xce, 'evm byte 2');
  eq(b[95], 0x03, 'amount hi');
  eq(b[96], 0xe8, 'amount lo');
  eq(b[104], 7, 'seq');
  eq(b[105], 1, 'verified');
  eq(b[106], 0, 'frozen');
  eq(b[107], 0x03, 'country hi');
  eq(b[108], 0x48, 'country lo');
});

test('IDENTITY and GLOBAL encodings match the pinned layouts', async () => {
  const { chain } = await setup();
  const codec = await chain.deploy('CodecHarness');

  const identity = (await codec.call('encodeIdentity', [addr(0xb0b), 3n, false, true, 76]))
    .decoded[0];
  eq((identity.length - 2) / 2, 45, 'IDENTITY length');
  const i = ethers.getBytes(identity);
  eq(i[0], 2, 'kind');
  eq(i[40], 3, 'seq');
  eq(i[41], 0, 'verified');
  eq(i[42], 1, 'frozen');
  eq(i[44], 76, 'country');

  // GLOBAL carries token STATE only. Rule parameters live in the Starknet
  // MirroredCompliance, replicated at allowance time, not on the wire.
  const global = (await codec.call('encodeGlobal', [2n, true])).decoded[0];
  eq((global.length - 2) / 2, 10, 'GLOBAL length');
  const g = ethers.getBytes(global);
  eq(g[0], 3, 'kind');
  eq(g[8], 2, 'seq');
  eq(g[9], 1, 'paused');
});

test('UNLOCK decodes what the Cairo encoder produces', async () => {
  const { chain } = await setup();
  const codec = await chain.deploy('CodecHarness');

  // Byte-identical to `encode_unlock(0xB0B, 42)` in the Cairo test.
  const res = await codec.call('decodeUnlock', [unlockMsg(addr(0xb0b), 42n)]);
  succeeds(res, 'decodeUnlock');
  eq(res.decoded[0].toLowerCase(), addr(0xb0b), 'recipient');
  eq(res.decoded[1], 42n, 'amount');
});

test('UNLOCK refuses a dirty address word instead of truncating it', async () => {
  const { chain } = await setup();
  const codec = await chain.deploy('CodecHarness');

  // High bytes set: truncating would silently alias a different account.
  const dirty = ethers.solidityPacked(
    ['uint8', 'bytes32', 'uint256'],
    [4, B32('0x010000000000000000000000000000000000000b0b'), 42n]
  );
  reverts(await codec.call('decodeUnlock', [dirty]), 'DirtyAddressWord');
});

test('UNLOCK refuses a wrong length or kind', async () => {
  const { chain } = await setup();
  const codec = await chain.deploy('CodecHarness');

  reverts(await codec.call('decodeUnlock', ['0x04']), 'BadLength', 'short');
  const wrongKind = ethers.solidityPacked(
    ['uint8', 'bytes32', 'uint256'],
    [1, B32(BigInt(addr(0xb0b))), 42n]
  );
  reverts(await codec.call('decodeUnlock', [wrongKind]), 'BadKind', 'kind');
});

// ---------------------------------------------------------------- outbound

test('bridgeOut escrows and ships the sender compliance snapshot', async () => {
  const { token, endpoint, lockbox, chain } = await setup();

  succeeds(await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE));

  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1000n, 'escrowed');
  eq((await token.call('balanceOf', [addr(ALICE)])).decoded[0], 999000n, 'alice debited');
  eq((await lockbox.call('totalEscrowed')).decoded[0], 1000n, 'totalEscrowed');
  eq((await lockbox.call('seq')).decoded[0], 1n, 'seq');

  eq((await endpoint.call('lastDstEid')).decoded[0], BigInt(DST_EID), 'dst eid');
  eq((await endpoint.call('lastReceiver')).decoded[0], PEER, 'receiver');
  eq((await endpoint.call('lastRefund')).decoded[0].toLowerCase(), addr(REFUND), 'refund');

  // The message carries Alice's live registry state, not a caller-supplied one.
  const codec = await chain.deploy('CodecHarness');
  const message = (await endpoint.call('lastMessage')).decoded[0];
  const decoded = await codec.call('decodeMint', [message]);
  succeeds(decoded, 'decodeMint');
  eq(decoded.decoded[0].toLowerCase(), addr(ALICE), 'evm sender');
  eq(decoded.decoded[1], B32(101), 'sn recipient');
  eq(decoded.decoded[2], 1000n, 'amount');
  eq(decoded.decoded[3], 1n, 'seq');
  eq(decoded.decoded[4], true, 'verified');
  eq(decoded.decoded[5], false, 'frozen');
  eq(decoded.decoded[6], 840n, 'country');
});

test('bridgeOutToPool carries the delivery mode and the note id', async () => {
  const { token, endpoint, lockbox, chain } = await setup();
  const NOTE = B32('0xbeef');

  succeeds(
    await lockbox.call('bridgeOutToPool', [1000n, B32(101), NOTE, 200000n, addr(REFUND)], ALICE),
    'bridgeOutToPool'
  );
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1000n, 'escrowed');

  const codec = await chain.deploy('CodecHarness');
  const message = (await endpoint.call('lastMessage')).decoded[0];
  const decoded = await codec.call('decodeMint', [message]);
  succeeds(decoded, 'decodeMint');
  eq(decoded.decoded[7], 1n, 'delivery = POOL');
  eq(decoded.decoded[8], NOTE, 'note id');
});

test('a pool transfer without a note id is refused before spending a message', async () => {
  const { endpoint, lockbox } = await setup();
  // A pool delivery with no note has nothing to fill; it would silently
  // degrade to the wallet on the far side, so refuse it here where it is free.
  reverts(
    await lockbox.call('bridgeOutToPool', [1000n, B32(101), B32(0), 200000n, addr(REFUND)], ALICE),
    'ZeroNoteId'
  );
  eq((await endpoint.call('sendCount')).decoded[0], 0n, 'message sent');
});

test('a wallet transfer carries no note and mode zero', async () => {
  const { endpoint, lockbox, chain } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);
  const codec = await chain.deploy('CodecHarness');
  const decoded = await codec.call('decodeMint', [(await endpoint.call('lastMessage')).decoded[0]]);
  eq(decoded.decoded[7], 0n, 'delivery = WALLET');
  eq(decoded.decoded[8], B32(0), 'no note id');
});

test('bridgeOut refuses an unverified sender before spending a message', async () => {
  const { registry, endpoint, lockbox } = await setup();
  await registry.call('setVerified', [addr(ALICE), false]);

  reverts(
    await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE),
    'NotVerified'
  );
  eq((await endpoint.call('sendCount')).decoded[0], 0n, 'no message sent');
});

test('bridgeOut fails while the lockbox is not a registered identity', async () => {
  // The deployment precondition, asserted: T-REX verifies the RECIPIENT of a
  // transfer, and on a bridge-out that is the lockbox. Until the issuer
  // registers it, nothing can be escrowed -- which is the issuer's consent
  // switch, and it is live.
  const { lockbox, endpoint } = await setup({ registerLockbox: false });
  reverts(
    await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE),
    'recipient not verified'
  );
  eq((await endpoint.call('sendCount')).decoded[0], 0n, 'no message sent');
});

test('bridgeOut is blocked by the token pause and by a freeze', async () => {
  const { token, lockbox } = await setup();

  await token.call('setPaused', [true]);
  reverts(await lockbox.call('bridgeOut', [1n, B32(101), 200000n, addr(REFUND)], ALICE), 'paused');
  await token.call('setPaused', [false]);

  await token.call('setFrozen', [addr(ALICE), true]);
  reverts(
    await lockbox.call('bridgeOut', [1n, B32(101), 200000n, addr(REFUND)], ALICE),
    'sender frozen'
  );
});

test('bridgeOut is blocked by a compliance module saying no', async () => {
  const { compliance, lockbox } = await setup();
  await compliance.call('setAllow', [false]);
  reverts(
    await lockbox.call('bridgeOut', [1n, B32(101), 200000n, addr(REFUND)], ALICE),
    'compliance'
  );
});

test('syncCompliance is permissionless and forwards only live registry state', async () => {
  const { registry, endpoint, lockbox, chain } = await setup();
  const codec = await chain.deploy('CodecHarness');

  // Mallory pushes Alice's revocation. She cannot assert anything of her own --
  // the values come from the registry -- which is what makes the mirror's
  // staleness window closable by anyone.
  await registry.call('setVerified', [addr(ALICE), false]);
  succeeds(await lockbox.call('syncCompliance', [addr(ALICE), 200000n, addr(REFUND)], MALLORY));

  const message = (await endpoint.call('lastMessage')).decoded[0];
  eq(ethers.getBytes(message)[0], 2, 'kind IDENTITY');
  eq((message.length - 2) / 2, 45, 'length');
  eq(ethers.getBytes(message)[41], 0, 'verified=false forwarded');

  // And it cannot be used to assert eligibility that does not exist.
  await registry.call('setVerified', [addr(ALICE), true]);
  succeeds(await lockbox.call('syncCompliance', [addr(ALICE), 200000n, addr(REFUND)], MALLORY));
  eq(ethers.getBytes((await endpoint.call('lastMessage')).decoded[0])[41], 1, 'verified=true');
});

test('sequence numbers are strictly increasing across every account message', async () => {
  const { lockbox } = await setup();
  await lockbox.call('bridgeOut', [1n, B32(101), 200000n, addr(REFUND)], ALICE);
  eq((await lockbox.call('seq')).decoded[0], 1n, 'after bridgeOut');
  await lockbox.call('syncCompliance', [addr(ALICE), 200000n, addr(REFUND)], MALLORY);
  eq((await lockbox.call('seq')).decoded[0], 2n, 'after sync');
  await lockbox.call('syncCompliance', [addr(BOB), 200000n, addr(REFUND)], MALLORY);
  eq((await lockbox.call('seq')).decoded[0], 3n, 'shared counter');
});

test('syncGlobal mirrors the live pause flag', async () => {
  const { token, endpoint, lockbox } = await setup();
  await token.call('setPaused', [true]);

  succeeds(await lockbox.call('syncGlobal', [200000n, addr(REFUND)], MALLORY));
  const g = ethers.getBytes((await endpoint.call('lastMessage')).decoded[0]);
  eq(g[0], 3, 'kind GLOBAL');
  eq(g[8], 1, 'globalSeq');
  eq(g[9], 1, 'paused mirrored');

  await token.call('setPaused', [false]);
  succeeds(await lockbox.call('syncGlobal', [200000n, addr(REFUND)], MALLORY));
  const g2 = ethers.getBytes((await endpoint.call('lastMessage')).decoded[0]);
  eq(g2[8], 2, 'globalSeq increments');
  eq(g2[9], 0, 'unpause mirrored');
});

test('only the owner may set the destination or the peer', async () => {
  const { lockbox } = await setup();
  reverts(await lockbox.call('setDstEid', [1n], MALLORY), 'NotOwner');
  reverts(await lockbox.call('setPeer', [DST_EID, PEER], MALLORY), 'NotOwner');
});

// ----------------------------------------------------------------- inbound

test('an unlock releases escrow to a verified recipient', async () => {
  const { token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);

  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 400n), 'deliver');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'released');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 600n, 'still escrowed');
  eq((await lockbox.call('totalEscrowed')).decoded[0], 600n, 'totalEscrowed');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 0n, 'nothing held');
});

test('an unlock to an ineligible recipient is held, never reverted', async () => {
  const { registry, token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);
  await registry.call('setVerified', [addr(BOB), false]);

  // The twin is already burned on Starknet; reverting would destroy the claim.
  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 400n), 'deliver');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 0n, 'not released');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 400n, 'held');
  eq((await lockbox.call('totalClaimable')).decoded[0], 400n, 'totalClaimable');
  eq((await lockbox.call('totalEscrowed')).decoded[0], 1000n, 'escrow intact');
});

test('an unlock the token itself rejects is held rather than bubbling', async () => {
  const { token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);
  // Verified but frozen: the registry says yes, the token says no.
  await token.call('setFrozen', [addr(BOB), true]);

  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 400n), 'deliver');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 400n, 'held');
});

test('a held release is claimable once eligibility returns', async () => {
  const { registry, token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);
  await registry.call('setVerified', [addr(BOB), false]);
  await deliverUnlock(endpoint, lockbox, addr(BOB), 400n);

  reverts(await lockbox.call('claim', [addr(BOB)], MALLORY), 'StillIneligible');

  await registry.call('setVerified', [addr(BOB), true]);
  // Permissionless: the funds can only go where the original message said.
  succeeds(await lockbox.call('claim', [addr(BOB)], MALLORY), 'claim');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'released');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 0n, 'cleared');
  eq((await lockbox.call('totalClaimable')).decoded[0], 0n, 'totalClaimable');
  eq((await lockbox.call('totalEscrowed')).decoded[0], 600n, 'totalEscrowed');

  reverts(await lockbox.call('claim', [addr(BOB)], MALLORY), 'NothingClaimable', 'double claim');
});

test('only the endpoint and only the configured peer may deliver', async () => {
  const { endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);

  // Straight call, not via the endpoint.
  const direct = await lockbox.call(
    'lzReceive',
    [[DST_EID, PEER, 1n], B32(1), unlockMsg(addr(BOB), 400n), addr(0), '0x'],
    MALLORY
  );
  reverts(direct, 'OnlyEndpoint');

  // Via the endpoint, but claiming to be someone else.
  const impostor = await endpoint.call('deliver', [
    lockbox.hex,
    DST_EID,
    B32('0xbadbad'),
    1n,
    unlockMsg(addr(BOB), 400n),
  ]);
  reverts(impostor, sel('OnlyPeer(uint32,bytes32)'), 'impostor peer');

  // From an eid we never configured.
  const wrongChain = await endpoint.call('deliver', [
    lockbox.hex,
    12345,
    PEER,
    1n,
    unlockMsg(addr(BOB), 400n),
  ]);
  reverts(wrongChain, sel('NoPeer(uint32)'), 'unconfigured eid');
});

test('escrow accounting balances across a full round trip', async () => {
  const { registry, token, endpoint, lockbox } = await setup();

  await lockbox.call('bridgeOut', [1000n, B32(101), 200000n, addr(REFUND)], ALICE);
  await lockbox.call('bridgeOut', [500n, B32(202), 200000n, addr(REFUND)], ALICE);
  eq((await lockbox.call('totalEscrowed')).decoded[0], 1500n, 'escrowed');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1500n, 'held by lockbox');

  // One release lands, one is held.
  await deliverUnlock(endpoint, lockbox, addr(BOB), 400n, 1);
  await registry.call('setVerified', [addr(BOB), false]);
  await deliverUnlock(endpoint, lockbox, addr(BOB), 600n, 2);

  // Escrow still covers everything outstanding: what is still represented by
  // twin supply, plus what is held for a claim.
  const escrowed = (await lockbox.call('totalEscrowed')).decoded[0];
  const claimable = (await lockbox.call('totalClaimable')).decoded[0];
  eq(escrowed, 1100n, 'escrowed after releases');
  eq(claimable, 600n, 'claimable');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], escrowed, 'balance == escrowed');
  ok(claimable <= escrowed, 'claims are fully backed');
});

// ------------------------------------------------- T-REX introspection

/// A compliance with all five mirrorable modules bound, configured the way an
/// issuer would, plus one module that reverts on everything.
async function setupModules(chain) {
  const compliance = await chain.deploy('MockModularCompliance');
  const token = await chain.deploy('MockERC3643Token', [addr(0xbeef), compliance.hex]);
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

  // US and France allowed, North Korea restricted, 1M supply cap.
  await countryAllow.call('setCountryAllowed', [compliance.hex, 840, true]);
  await countryAllow.call('setCountryAllowed', [compliance.hex, 250, true]);
  await countryRestrict.call('setCountryRestricted', [compliance.hex, 408, true]);
  await supplyLimit.call('setSupplyLimit', [compliance.hex, 1_000_000n]);
  await transferRestrict.call('setUserAllowed', [compliance.hex, addr(ALICE), true]);
  await maxBalance.call('setMaxBalance', [compliance.hex, 5000n]);

  return { compliance, token, countryAllow, countryRestrict, supplyLimit, transferRestrict, maxBalance, hostile };
}

test('the reader enumerates bound modules by name', async () => {
  const chain = await Chain_.create();
  const reader = await chain.deploy('ComplianceReader');
  const m = await setupModules(chain);

  const res = await reader.call('readModules', [m.compliance.hex]);
  succeeds(res, 'readModules');
  const [modules, names] = res.decoded;
  eq(modules.length, 6, 'module count');
  eq(names[0], 'CountryAllowModule', 'name 0');
  eq(names[1], 'CountryRestrictModule', 'name 1');
  eq(names[2], 'SupplyLimitModule', 'name 2');
  eq(names[3], 'TransferRestrictModule', 'name 3');
  eq(names[4], 'MaxBalanceModule', 'name 4');
});

test('the reader confirms country config against live state', async () => {
  const chain = await Chain_.create();
  const reader = await chain.deploy('ComplianceReader');
  const m = await setupModules(chain);

  // Candidates come from event logs off-chain; the reader says which are
  // STILL set, which is what stops a since-removed country being replicated.
  const allowed = await reader.call('probeCountriesAllowed', [
    m.countryAllow.hex,
    m.compliance.hex,
    [840, 250, 76],
  ]);
  succeeds(allowed, 'probeCountriesAllowed');
  eq(allowed.decoded[0].join(','), 'true,true,false', 'allowed set');

  const restricted = await reader.call('probeCountriesRestricted', [
    m.countryRestrict.hex,
    m.compliance.hex,
    [408, 840],
  ]);
  eq(restricted.decoded[0].join(','), 'true,false', 'restricted set');
});

test('a country removed after being set is not replicated', async () => {
  const chain = await Chain_.create();
  const reader = await chain.deploy('ComplianceReader');
  const m = await setupModules(chain);

  // France was allowed, then withdrawn. The event log still shows it; live
  // state does not. Replicating from events alone would reinstate it.
  await m.countryAllow.call('setCountryAllowed', [m.compliance.hex, 250, false]);
  const allowed = await reader.call('probeCountriesAllowed', [
    m.countryAllow.hex,
    m.compliance.hex,
    [840, 250],
  ]);
  eq(allowed.decoded[0].join(','), 'true,false', 'withdrawn country excluded');
});

test('the reader reads the supply limit and the transfer allow-list', async () => {
  const chain = await Chain_.create();
  const reader = await chain.deploy('ComplianceReader');
  const m = await setupModules(chain);

  const limit = await reader.call('readSupplyLimit', [m.supplyLimit.hex, m.compliance.hex]);
  eq(limit.decoded[0], 1_000_000n, 'supply limit');

  const users = await reader.call('probeUsersAllowed', [
    m.transferRestrict.hex,
    m.compliance.hex,
    [addr(ALICE), addr(BOB)],
  ]);
  eq(users.decoded[0].join(','), 'true,false', 'allow-list');
});

test('a module that reverts degrades to false instead of failing the export', async () => {
  const chain = await Chain_.create();
  const reader = await chain.deploy('ComplianceReader');
  const m = await setupModules(chain);

  // The whole point: one broken or unexpected module must not make the asset
  // un-exportable, or an issuer with a custom module could never be onboarded.
  const res = await reader.call('probeCountriesAllowed', [
    m.hostile.hex,
    m.compliance.hex,
    [840, 250],
  ]);
  succeeds(res, 'probe survives a hostile module');
  eq(res.decoded[0].join(','), 'false,false', 'hostile reads as false');
});

test('the reader reports token wiring and pause state', async () => {
  const chain = await Chain_.create();
  const reader = await chain.deploy('ComplianceReader');
  const m = await setupModules(chain);
  await m.token.call('mint', [addr(ALICE), 1234n]);
  await m.token.call('setPaused', [true]);

  const info = (await reader.call('readToken', [m.token.hex])).decoded[0];
  eq(info.compliance.toLowerCase(), m.compliance.hex.toLowerCase(), 'compliance');
  eq(info.paused, true, 'paused');
  eq(info.totalSupply, 1234n, 'total supply');
});

run();
