// Attack tests for the EVM half of the bridge.
//
// Every test is an attempt to steal, drain, or forge. Successes appear only
// where they set up an attack or prove one was blocked for the right reason.
//
// Threat model, stated so the gaps are visible rather than implied:
//
//   ASSUMED HONEST -- the owner, the issuer's agents, the configured LayerZero
//   peer and the DVN set backing the pathway. A compromised peer can order
//   arbitrary releases; that is inherent to any bridge, which is why the DVN
//   configuration is part of the security argument rather than an afterthought.
//   The tests below still pin what a bad message CANNOT do: move value that is
//   not there.
//
//   ASSUMED HOSTILE -- everyone else, including the token itself, which the
//   issuer chooses and the lockbox cannot vet.
//
// The invariant: no caller can cause the lockbox to part with tokens except to
// the address a peer message named, and only while that address is eligible.

const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const OWNER = 1;
// Every bridge-out names a note: there is no wallet delivery.
const NOTE_D = '0x' + 'ab'.repeat(32);
const ALICE = 2;
const BOB = 3;
const MALLORY = 5;
const REFUND = 6;

const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const B32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
/// Errors raised inside the lockbox but delivered through the mock endpoint come
/// back as raw data, so those assertions match on the selector.
const sel = (sig) => ethers.id(sig).slice(0, 10);

const DST_EID = 30500;
const PEER = B32('0xdeadbeef');

async function setup({ tokenContract = 'MockERC3643Token' } = {}) {
  const chain = await Chain_.create();
  const registry = await chain.deploy('MockIdentityRegistry');
  const compliance = await chain.deploy('MockCompliance');
  const token = await chain.deploy(tokenContract, [registry.hex, compliance.hex]);
  const endpoint = await chain.deploy('MockEndpoint');
  const lockbox = await chain.deploy('VeilERC3643Lockbox', [
    endpoint.hex,
    addr(OWNER),
    token.hex,
    DST_EID,
  ]);

  await lockbox.call('setPeer', [DST_EID, PEER], OWNER);
  for (const a of [ALICE, BOB, MALLORY]) await registry.call('setVerified', [addr(a), true]);
  await registry.call('setVerified', [lockbox.hex, true]);
  await token.call('mint', [addr(ALICE), 1_000_000n]);
  await token.call('approve', [lockbox.hex, 1_000_000n], ALICE);
  if (tokenContract === 'MockReentrantToken') await token.call('setLockbox', [lockbox.hex]);

  return { chain, registry, compliance, token, endpoint, lockbox };
}

const unlockMsg = (recipient, amount) =>
  ethers.solidityPacked(['uint8', 'bytes32', 'uint256'], [4, B32(BigInt(recipient)), amount]);

const deliverUnlock = (endpoint, lockbox, recipient, amount, nonce = 1) =>
  endpoint.call('deliver', [lockbox.hex, DST_EID, PEER, nonce, unlockMsg(recipient, amount)]);

// ---------------------------------------------------------- forged messages

test('mallory cannot release escrow by calling lzReceive herself', async () => {
  const { token, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);

  const res = await lockbox.call(
    'lzReceive',
    [[DST_EID, PEER, 1n], B32(1), unlockMsg(addr(MALLORY), 1000n), addr(0), '0x'],
    MALLORY
  );
  reverts(res, 'OnlyEndpoint');
  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'mallory paid');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1000n, 'escrow touched');
});

test('mallory cannot release escrow by spoofing the source contract', async () => {
  const { token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);

  const res = await endpoint.call('deliver', [
    lockbox.hex,
    DST_EID,
    B32('0xbadbad'),
    1n,
    unlockMsg(addr(MALLORY), 1000n),
  ]);
  reverts(res, sel('OnlyPeer(uint32,bytes32)'));
  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'mallory paid');
});

test('mallory cannot release escrow from a chain that was never configured', async () => {
  const { token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);

  const res = await endpoint.call('deliver', [
    lockbox.hex,
    12345,
    PEER,
    1n,
    unlockMsg(addr(MALLORY), 1000n),
  ]);
  reverts(res, sel('NoPeer(uint32)'));
  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'mallory paid');
});

test('an unlock larger than the escrow moves no value', async () => {
  const { token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);

  // Even from the trusted peer, a release the escrow cannot cover must not
  // reach into whatever else the lockbox happens to hold.
  succeeds(await deliverUnlock(endpoint, lockbox, addr(MALLORY), 10_000n), 'deliver');
  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'mallory paid');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1000n, 'escrow drained');

  // It is recorded as claimable, but the claim cannot conjure the tokens either.
  reverts(await lockbox.call('claim', [addr(MALLORY)], MALLORY), 'balance');
  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'claim paid out');
});

// ------------------------------------------------------------------ claims

test('mallory cannot redirect a held release to herself', async () => {
  const { registry, token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);
  await registry.call('setVerified', [addr(BOB), false]);
  await deliverUnlock(endpoint, lockbox, addr(BOB), 400n);
  await registry.call('setVerified', [addr(BOB), true]);

  // Claiming is permissionless on purpose -- but it pays the named recipient.
  succeeds(await lockbox.call('claim', [addr(BOB)], MALLORY), 'claim');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'bob unpaid');
  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'mallory paid');
});

test('a held release cannot be claimed twice', async () => {
  const { registry, token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);
  await registry.call('setVerified', [addr(BOB), false]);
  await deliverUnlock(endpoint, lockbox, addr(BOB), 400n);
  await registry.call('setVerified', [addr(BOB), true]);

  succeeds(await lockbox.call('claim', [addr(BOB)], MALLORY), 'first claim');
  reverts(await lockbox.call('claim', [addr(BOB)], MALLORY), 'NothingClaimable');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'double paid');
});

test('a re-entrant token cannot drain a claim twice', async () => {
  const { registry, token, endpoint, lockbox } = await setup({ tokenContract: 'MockReentrantToken' });
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);
  await registry.call('setVerified', [addr(BOB), false]);
  await deliverUnlock(endpoint, lockbox, addr(BOB), 400n);
  await registry.call('setVerified', [addr(BOB), true]);

  // The token re-enters `claim` for the same recipient mid-transfer.
  await token.call('setReenterFor', [addr(BOB)]);
  succeeds(await lockbox.call('claim', [addr(BOB)], MALLORY), 'claim');

  eq((await token.call('reentryAttempted')).decoded[0], true, 're-entry never fired');
  eq((await token.call('reentrySucceeded')).decoded[0], false, 're-entrant claim succeeded');
  // Paid exactly once: the bookkeeping is cleared before the outbound call.
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'double paid');
  eq((await lockbox.call('claimable', [addr(BOB)])).decoded[0], 0n, 'claimable left over');
});

test('tokens donated to the lockbox cannot be claimed by anyone', async () => {
  const { token, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);
  // A direct transfer in is not escrow: no message ever named a recipient for
  // it, so there is no claim to make against it.
  await token.call('mint', [addr(MALLORY), 5000n]);
  await token.call('transfer', [lockbox.hex, 5000n], MALLORY);

  reverts(await lockbox.call('claim', [addr(MALLORY)], MALLORY), 'NothingClaimable');
  eq((await lockbox.call('totalEscrowed')).decoded[0], 1000n, 'donation counted as escrow');
});

// ------------------------------------------------------------- bridging out

test('mallory cannot escrow a victim tokens she was never approved for', async () => {
  const { token, lockbox } = await setup();
  // Alice approved the LOCKBOX, not Mallory, and bridgeOut pulls from the caller.
  reverts(
    await lockbox.call('bridgeOut', [1000n, B32(999), NOTE_D, B32(0), 200000n, addr(REFUND)], MALLORY),
    'balance'
  );
  eq((await token.call('balanceOf', [addr(ALICE)])).decoded[0], 1_000_000n, 'alice debited');
});

test('an unverified attacker cannot escrow even holding tokens', async () => {
  const { registry, token, endpoint, lockbox } = await setup();
  await token.call('mint', [addr(MALLORY), 5000n]);
  await token.call('approve', [lockbox.hex, 5000n], MALLORY);
  await registry.call('setVerified', [addr(MALLORY), false]);

  reverts(
    await lockbox.call('bridgeOut', [5000n, B32(999), NOTE_D, B32(0), 200000n, addr(REFUND)], MALLORY),
    'NotVerified'
  );
  eq((await endpoint.call('sendCount')).decoded[0], 0n, 'message sent anyway');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 0n, 'escrowed anyway');
});

test('a zero-amount bridgeOut is refused rather than spending a message', async () => {
  const { endpoint, lockbox } = await setup();
  reverts(await lockbox.call('bridgeOut', [0n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE), 'ZeroAmount');
  eq((await endpoint.call('sendCount')).decoded[0], 0n, 'message sent');
});

// -------------------------------------------------------------- compliance

test('mallory cannot use syncCompliance to assert eligibility she lacks', async () => {
  const { registry, endpoint, lockbox } = await setup();
  await registry.call('setVerified', [addr(MALLORY), false]);

  // The call is permissionless, but every field is read from the live registry,
  // so the most she can do is broadcast the truth about herself.
  succeeds(await lockbox.call('syncCompliance', [addr(MALLORY), 200000n, addr(REFUND)], MALLORY));
  const msg = ethers.getBytes((await endpoint.call('lastMessage')).decoded[0]);
  eq(msg[0], 2, 'kind IDENTITY');
  eq(msg[41], 0, 'verified flag forged');
});

test('mallory cannot replay an old eligibility state at a lower sequence', async () => {
  const { registry, endpoint, lockbox } = await setup();
  // Sequence numbers come from the lockbox counter, never from the caller, and
  // only ever increase -- so a "replay" is just a fresh read of current truth.
  succeeds(await lockbox.call('syncCompliance', [addr(MALLORY), 200000n, addr(REFUND)], MALLORY));
  const first = ethers.getBytes((await endpoint.call('lastMessage')).decoded[0]);
  eq(first[41], 1, 'expected verified');

  await registry.call('setVerified', [addr(MALLORY), false]);
  succeeds(await lockbox.call('syncCompliance', [addr(MALLORY), 200000n, addr(REFUND)], MALLORY));
  const second = ethers.getBytes((await endpoint.call('lastMessage')).decoded[0]);
  eq(second[41], 0, 'stale verified replayed');
  ok(
    BigInt('0x' + Buffer.from(second.slice(33, 41)).toString('hex')) >
      BigInt('0x' + Buffer.from(first.slice(33, 41)).toString('hex')),
    'sequence did not increase'
  );
});

// --------------------------------------------------------------- privilege

test('mallory cannot repoint the peer at a contract she controls', async () => {
  const { lockbox } = await setup();
  // Owning the peer would mean ordering arbitrary releases.
  reverts(await lockbox.call('setPeer', [DST_EID, B32('0xbad')], MALLORY), 'NotOwner');
  reverts(await lockbox.call('setDstEid', [1n], MALLORY), 'NotOwner');
  reverts(await lockbox.call('transferOwnership', [addr(MALLORY)], MALLORY), 'NotOwner');
  reverts(await lockbox.call('setDelegate', [addr(MALLORY)], MALLORY), 'NotOwner');
});

test('escrow accounting survives a full attack sequence', async () => {
  const { registry, token, endpoint, lockbox } = await setup();
  await lockbox.call('bridgeOut', [1000n, B32(101), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);
  await lockbox.call('bridgeOut', [500n, B32(202), NOTE_D, B32(0), 200000n, addr(REFUND)], ALICE);

  // Everything Mallory can legally reach, in sequence.
  await lockbox.call('lzReceive', [[DST_EID, PEER, 9n], B32(9), unlockMsg(addr(MALLORY), 1500n), addr(0), '0x'], MALLORY);
  await endpoint.call('deliver', [lockbox.hex, DST_EID, B32('0xbad'), 9n, unlockMsg(addr(MALLORY), 1500n)]);
  await lockbox.call('claim', [addr(MALLORY)], MALLORY);
  await lockbox.call('syncCompliance', [addr(MALLORY), 200000n, addr(REFUND)], MALLORY);
  await lockbox.call('bridgeOut', [1n, B32(303), NOTE_D, B32(0), 200000n, addr(REFUND)], MALLORY);

  eq((await token.call('balanceOf', [addr(MALLORY)])).decoded[0], 0n, 'mallory gained');
  eq((await token.call('balanceOf', [lockbox.hex])).decoded[0], 1500n, 'escrow moved');
  eq((await lockbox.call('totalEscrowed')).decoded[0], 1500n, 'accounting drifted');

  // And a legitimate release still works afterwards.
  succeeds(await deliverUnlock(endpoint, lockbox, addr(BOB), 400n, 10n), 'legit release');
  eq((await token.call('balanceOf', [addr(BOB)])).decoded[0], 400n, 'bob unpaid');
});

run();
