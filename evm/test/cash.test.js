// The cash leg's EVM half: a holder's wallet contract burns USDC through
// Circle's CCTP V2 into a Veil pool note on Starknet (contracts/cash/VeilCash.sol).
// What the Starknet vault then parses is covered by cairo/tests/test_cash.cairo;
// here, that the burn names the vault as mint recipient AND sole relayer, and
// carries exactly the note id as 32 bytes of hook data.
const { Chain_, test, eq, ok, reverts, succeeds, run, ethers } = require('./harness');

const WALLET_OWNER = 1;
const VAULT = '0x' + '0'.repeat(2) + 'ab'.repeat(31); // a Starknet address (felt) as bytes32
const NOTE = '0x0' + '7'.repeat(63);
const AMOUNT = 250_000_000n; // 250 USDC

async function setup() {
  const chain = await Chain_.create();
  const usdc = await chain.deploy('MockUSDC');
  const messenger = await chain.deploy('MockTokenMessengerV2');
  const wallet = await chain.deploy('CashWallet');
  succeeds(await usdc.call('mint', [wallet.hex, 1000n * 10n ** 6n]));
  return { chain, usdc, messenger, wallet };
}
const get = async (c, fn, args = []) => (await c.call(fn, args)).decoded[0];

test('the wallet burns into the note, with the vault as mint recipient and sole relayer', async () => {
  const env = await setup();
  succeeds(await env.wallet.call('moveCashToVeil',
    [env.messenger.hex, env.usdc.hex, AMOUNT, VAULT, NOTE, 0n, 2000], WALLET_OWNER));
  const m = env.messenger;
  eq(await get(m, 'lastAmount'), AMOUNT, 'amount');
  eq(Number(await get(m, 'lastDestinationDomain')), 25, 'Starknet domain');
  eq((await get(m, 'lastMintRecipient')).toLowerCase(), VAULT, 'minted to the vault');
  eq((await get(m, 'lastDestinationCaller')).toLowerCase(), VAULT, 'only the vault relays');
  eq((await get(m, 'lastBurnToken')).toLowerCase(), env.usdc.hex.toLowerCase(), 'burn token');
  eq(await get(m, 'lastMaxFee'), 0n, 'standard transfer: no fee');
  eq(Number(await get(m, 'lastMinFinality')), 2000, 'finalized');
  const hook = await get(m, 'lastHookData');
  eq(ethers.dataLength(hook), 32, 'hook data is exactly one 32-byte word');
  eq(hook.toLowerCase(), NOTE, 'the note id');
  eq((await get(m, 'lastSender')).toLowerCase(), env.wallet.hex.toLowerCase(),
    'the wallet is the CCTP message sender (the refund address)');
  eq(await get(env.usdc, 'balanceOf', [env.wallet.hex]), 1000n * 10n ** 6n - AMOUNT, 'debited');
  eq(await get(env.usdc, 'allowance', [env.wallet.hex, m.hex]), 0n, 'no allowance left');
});

test('fast transfer passes its fee cap and finality through', async () => {
  const env = await setup();
  succeeds(await env.wallet.call('moveCashToVeil',
    [env.messenger.hex, env.usdc.hex, AMOUNT, VAULT, NOTE, 30_000n, 1000], WALLET_OWNER));
  eq(await get(env.messenger, 'lastMaxFee'), 30_000n);
  eq(Number(await get(env.messenger, 'lastMinFinality')), 1000);
});

test('a zero note or vault is refused before anything is burned', async () => {
  const env = await setup();
  reverts(await env.wallet.call('moveCashToVeil',
    [env.messenger.hex, env.usdc.hex, AMOUNT, VAULT, ethers.ZeroHash, 0n, 2000]), 'ZeroNote');
  reverts(await env.wallet.call('moveCashToVeil',
    [env.messenger.hex, env.usdc.hex, AMOUNT, ethers.ZeroHash, NOTE, 0n, 2000]), 'ZeroVault');
  eq(await get(env.usdc, 'balanceOf', [env.wallet.hex]), 1000n * 10n ** 6n, 'nothing moved');
});

test('Circle refuses a fee cap at or above the amount; nothing moves', async () => {
  const env = await setup();
  reverts(await env.wallet.call('moveCashToVeil',
    [env.messenger.hex, env.usdc.hex, 100n, VAULT, NOTE, 100n, 1000]), 'Max fee must be less than amount');
  eq(await get(env.usdc, 'balanceOf', [env.wallet.hex]), 1000n * 10n ** 6n, 'nothing moved');
});

run();
