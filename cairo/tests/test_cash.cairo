// The cash leg (USDC over Circle's CCTP) end to end, against the REAL Veil pool.
//
// Deployed for every test: the real `VeilERC3643` pool carrying USDC as a
// rules token, the cash vault (in) and the cash exit (out), and a holder
// registered in the pool. Mocked, because they are Circle's: the FiatToken and
// the CCTP messenger / transmitter (src/cash_mocks.cairo). The source chain is
// played by the tests: they build Circle's V2 message byte for byte.

use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil::interfaces::IVeilERC3643::{IVeilERC3643Dispatcher, IVeilERC3643DispatcherTrait, InvokeSwap};
use veil_bridge::bytes::append_be;
use veil_bridge::cash_cctp::{
    ETHEREUM_DOMAIN, ICashERC20Dispatcher, ICashERC20DispatcherTrait,
    IMessageTransmitterV2Dispatcher, IMessageTransmitterV2DispatcherTrait, STANDARD_FINALITY,
    STARKNET_DOMAIN, word_of,
};
use veil_bridge::cash_exit::{IVeilCashExitDispatcher, IVeilCashExitDispatcherTrait};
use veil_bridge::cash_rules::{ITransferRulesDispatcher, ITransferRulesDispatcherTrait};
use veil_bridge::cash_mocks::{
    IMockCashMessengerDispatcher, IMockCashMessengerDispatcherTrait, IMockCashTokenDispatcher,
    IMockCashTokenDispatcherTrait,
};
use veil_bridge::cash_vault::{
    CASH_DELIVERED, CASH_HELD, CASH_REFUNDED, IVeilCashVaultDispatcher,
    IVeilCashVaultDispatcherTrait,
};
use super::proof::{create_open_note, curve_x, invoke, note_id, register, self_channel_key, virtual_tx};

fn owner() -> ContractAddress {
    0xA0.try_into().unwrap()
}
fn keeper() -> ContractAddress {
    0xB0.try_into().unwrap()
}
fn holder() -> ContractAddress {
    0xC0.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    0xD0.try_into().unwrap()
}

const KEY: felt252 = 0x51F3;
/// The buyer's wallet on Ethereum, as CCTP's 32-byte word.
const BUYER_EVM: u256 = 0x1111111111111111111111111111111111111111;
const OTHER_EVM: u256 = 0x2222222222222222222222222222222222222222;
/// USDC on Ethereum (the burn token field; not read on Starknet).
const ETH_USDC: u256 = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48;
const AMOUNT: u128 = 100_000_000; // 100 USDC
const TWO_POW_128: felt252 = 0x100000000000000000000000000000000;

#[derive(Drop, Copy)]
struct Env {
    pool: IVeilERC3643Dispatcher,
    usdc: ContractAddress,
    vault: IVeilCashVaultDispatcher,
    exit: ContractAddress,
    messenger: IMockCashMessengerDispatcher,
    transmitter: ContractAddress,
    rules: ContractAddress,
}

fn deploy(name: ByteArray, calldata: Array<felt252>) -> ContractAddress {
    let class = declare(name).unwrap().contract_class();
    let (address, _) = class.deploy(@calldata).unwrap();
    address
}

fn setup() -> Env {
    virtual_tx();
    start_cheat_block_timestamp_global(100);
    let usdc = deploy("MockCashToken", array![]);
    let rules = deploy("VeilCashRules", array![usdc.into()]);
    let pool = deploy(
        "VeilERC3643", array![owner().into(), owner().into(), curve_x(77), keeper().into()],
    );
    let messenger = deploy("MockCashMessenger", array![]);
    let transmitter = deploy("MockCashTransmitter", array![usdc.into()]);
    let vault = deploy(
        "VeilCashVault", array![pool.into(), usdc.into(), transmitter.into(), messenger.into()],
    );
    let exit = deploy(
        "VeilCashExit", array![pool.into(), usdc.into(), messenger.into(), ETHEREUM_DOMAIN.into()],
    );

    // USDC in the pool is a rules token, answered by VeilCashRules from
    // Circle's own pause and blocklist, exactly as deployed. The vault and the
    // exit are allowed adapters.
    let p = IVeilERC3643Dispatcher { contract_address: pool };
    start_cheat_caller_address(pool, owner());
    p.add_rules_token(usdc, rules);
    p.set_adapter_allowed(vault, true);
    p.set_adapter_allowed(exit, true);
    stop_cheat_caller_address(pool);

    register(p, holder(), KEY);
    Env {
        pool: p,
        usdc,
        vault: IVeilCashVaultDispatcher { contract_address: vault },
        exit,
        messenger: IMockCashMessengerDispatcher { contract_address: messenger },
        transmitter,
        rules,
    }
}

// ── Circle's CCTP V2 message, as the source chain produces it ────────────────

fn hook_for(note: felt252) -> ByteArray {
    let mut h: ByteArray = Default::default();
    append_be(ref h, note.into(), 32);
    h
}

fn cctp_message(
    nonce: u256,
    destination_caller: u256,
    mint_recipient: u256,
    amount: u256,
    sender: u256,
    fee_executed: u256,
    hook: ByteArray,
) -> ByteArray {
    let mut m: ByteArray = Default::default();
    append_be(ref m, 1, 4); // version
    append_be(ref m, ETHEREUM_DOMAIN.into(), 4);
    append_be(ref m, STARKNET_DOMAIN.into(), 4);
    append_be(ref m, nonce, 32);
    append_be(ref m, 0xAAAA, 32); // sender: TokenMessenger on the source chain
    append_be(ref m, 0xBBBB, 32); // recipient: TokenMessenger here
    append_be(ref m, destination_caller, 32);
    append_be(ref m, STANDARD_FINALITY.into(), 4);
    append_be(ref m, STANDARD_FINALITY.into(), 4);
    // Burn message body.
    append_be(ref m, 1, 4); // version
    append_be(ref m, ETH_USDC, 32); // burn token
    append_be(ref m, mint_recipient, 32);
    append_be(ref m, amount, 32);
    append_be(ref m, sender, 32); // message sender: the wallet that burned
    append_be(ref m, 0, 32); // max fee
    append_be(ref m, fee_executed, 32);
    append_be(ref m, 0, 32); // expiration block
    m.append(@hook);
    m
}

/// A buyer's burn on Ethereum into `note`, relayed through the vault.
fn deposit_message(env: Env, nonce: u256, note: felt252, amount: u128, sender: u256) -> ByteArray {
    let vault = word_of(env.vault.contract_address);
    cctp_message(nonce, vault, vault, amount.into(), sender, 0, hook_for(note))
}

fn balance(token: ContractAddress, holder: ContractAddress) -> u256 {
    ICashERC20Dispatcher { contract_address: token }.balance_of(holder)
}

fn note_value(env: Env, note: felt252) -> felt252 {
    *env.pool.get_notes_batch(array![note]).at(0).encrypted_amount
}

// ── In: Ethereum -> the pool ─────────────────────────────────────────────────

#[test]
fn a_cctp_deposit_fills_the_holders_open_note() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    // Anyone relays; the relayer learns nothing it could not read on-chain.
    start_cheat_caller_address(env.vault.contract_address, stranger());
    let id = env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    stop_cheat_caller_address(env.vault.contract_address);

    assert(id == env.vault.deposit_id_of(ETHEREUM_DOMAIN, 1), 'deposit id');
    let d = env.vault.deposit_of(id);
    assert(d.status == CASH_DELIVERED, 'delivered');
    assert(d.note_id == note && d.amount == AMOUNT && d.sender == BUYER_EVM, 'record');
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'note filled');
    assert(balance(env.usdc, env.pool.contract_address) == AMOUNT.into(), 'in the pool');
    assert(balance(env.usdc, env.vault.contract_address) == 0, 'nothing left in the vault');
}

#[test]
fn the_note_gets_what_cctp_minted_after_its_fee() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    let vault = word_of(env.vault.contract_address);
    let msg = cctp_message(7, vault, vault, AMOUNT.into(), BUYER_EVM, 12_000, hook_for(note));
    let id = env.vault.receive_deposit(msg, "ATTESTED");
    assert(env.vault.deposit_of(id).amount == AMOUNT - 12_000, 'net of the fast fee');
    assert(note_value(env, note) == TWO_POW_128 + (AMOUNT - 12_000).into(), 'note');
}

#[test]
#[should_panic(expected: 'MOCK_WRONG_DESTINATION_CALLER')]
fn only_the_vault_can_relay_a_deposit_addressed_to_it() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    let msg = deposit_message(env, 1, note, AMOUNT, BUYER_EVM);
    start_cheat_caller_address(env.transmitter, stranger());
    IMessageTransmitterV2Dispatcher { contract_address: env.transmitter }
        .receive_message(msg, "ATTESTED");
}

#[test]
#[should_panic(expected: 'MOCK_NONCE_USED')]
fn a_deposit_is_received_once() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
}

#[test]
fn a_second_deposit_into_a_filled_note_is_held_and_refunded_to_its_sender() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    // Someone else burns into the same, now filled, note.
    let id = env.vault.receive_deposit(deposit_message(env, 2, note, 5_000, OTHER_EVM), "ATTESTED");
    assert(env.vault.deposit_of(id).status == CASH_HELD, 'held');
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'first fill untouched');
    assert(balance(env.usdc, env.vault.contract_address) == 5_000, 'kept in the vault');

    start_cheat_caller_address(env.vault.contract_address, stranger());
    env.vault.refund(id, 0);
    stop_cheat_caller_address(env.vault.contract_address);
    let burn = env.messenger.last_burn();
    assert(burn.caller == env.vault.contract_address, 'burned by the vault');
    assert(burn.amount == 5_000, 'amount');
    assert(burn.destination_domain == ETHEREUM_DOMAIN, 'back where it came from');
    assert(burn.mint_recipient == OTHER_EVM, 'to the wallet that burned it');
    assert(burn.destination_caller == 0, 'anyone relays');
    assert(burn.min_finality_threshold == STANDARD_FINALITY, 'standard transfer');
    assert(env.vault.deposit_of(id).status == CASH_REFUNDED, 'refunded');
    assert(balance(env.usdc, env.vault.contract_address) == 0, 'vault empty');
}

#[test]
#[should_panic(expected: 'DEPOSIT_NOT_HELD')]
fn a_refund_happens_once() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    let id = env.vault.receive_deposit(deposit_message(env, 2, note, 5_000, OTHER_EVM), "ATTESTED");
    env.vault.refund(id, 0);
    env.vault.refund(id, 0);
}

#[test]
#[should_panic(expected: 'DEPOSIT_NOT_HELD')]
fn a_delivered_deposit_cannot_be_refunded() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    let id = env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    env.vault.refund(id, 0);
}

#[test]
fn a_deposit_naming_no_usdc_open_note_is_held_and_refundable() {
    let env = setup();
    // A felt that is no open note of this pool.
    let id = env.vault.receive_deposit(deposit_message(env, 1, 'NOT_A_NOTE', AMOUNT, BUYER_EVM), "ATTESTED");
    assert(env.vault.deposit_of(id).status == CASH_HELD, 'held');
    env.vault.refund(id, 0);
    assert(env.messenger.last_burn().mint_recipient == BUYER_EVM, 'refunded to the buyer');

    // Hook data that is not exactly one note id names no note at all.
    let mut short: ByteArray = Default::default();
    append_be(ref short, 0x1234, 20);
    let vault = word_of(env.vault.contract_address);
    let msg = cctp_message(2, vault, vault, AMOUNT.into(), BUYER_EVM, 0, short);
    let id2 = env.vault.receive_deposit(msg, "ATTESTED");
    let d = env.vault.deposit_of(id2);
    assert(d.status == CASH_HELD && d.note_id == 0, 'held, no note');
    env.vault.refund(id2, 0);
    assert(env.vault.deposit_of(id2).status == CASH_REFUNDED, 'refunded');
}

#[test]
fn a_paused_pool_holds_the_deposit_until_it_can_be_delivered() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.pause();
    stop_cheat_caller_address(env.pool.contract_address);
    let id = env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    assert(env.vault.deposit_of(id).status == CASH_HELD, 'held while paused');
    assert(note_value(env, note) == TWO_POW_128, 'note still empty');

    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.unpause();
    stop_cheat_caller_address(env.pool.contract_address);
    env.vault.retry_delivery(id);
    assert(env.vault.deposit_of(id).status == CASH_DELIVERED, 'delivered');
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'note filled');
}

#[test]
#[should_panic(expected: 'NOTE_STILL_FILLABLE')]
fn a_deposit_whose_note_can_still_take_it_is_not_refunded() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.pause();
    stop_cheat_caller_address(env.pool.contract_address);
    let id = env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    env.vault.refund(id, 0);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FILLABLE')]
fn retry_cannot_fill_a_note_that_is_gone() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    let id = env.vault.receive_deposit(deposit_message(env, 2, note, 5_000, OTHER_EVM), "ATTESTED");
    env.vault.retry_delivery(id);
}

#[test]
fn a_message_minted_to_someone_else_is_only_relayed() {
    let env = setup();
    let vault = word_of(env.vault.contract_address);
    let msg = cctp_message(1, vault, word_of(stranger()), AMOUNT.into(), BUYER_EVM, 0, hook_for(1));
    assert(env.vault.receive_deposit(msg, "ATTESTED") == 0, 'not a deposit');
    assert(balance(env.usdc, stranger()) == AMOUNT.into(), 'minted to its recipient');
    assert(env.vault.deposit_of(env.vault.deposit_id_of(ETHEREUM_DOMAIN, 1)).status == 0, 'no record');
}

// ── Out: the pool -> Ethereum ────────────────────────────────────────────────

// The first empty slot of USDC in the holder's self-channel.
fn free_slot(env: Env) -> u32 {
    let key = self_channel_key(holder(), KEY);
    let mut i: u32 = 0;
    while note_value(env, note_id(key, env.usdc, i)) != 0 {
        i += 1;
    }
    i
}

/// One proven invoke: `amount + 1` of the holder's USDC pays the exit, which
/// burns `amount` to `recipient` on Ethereum and returns 1 to the invoke's note.
fn exit_to(env: Env, amount: u128, recipient: u256) -> InvokeSwap {
    let open_note = note_id(self_channel_key(holder(), KEY), env.usdc, free_slot(env) + 1);
    let calldata = array![
        open_note, amount.into(), recipient.low.into(), recipient.high.into(), 0, 0,
        STANDARD_FINALITY.into(),
    ];
    let msg = invoke(env.pool, holder(), KEY, env.usdc, amount + 1, env.usdc, env.exit, calldata);
    assert(msg.open_note_id == open_note, 'open note slot');
    msg
}

#[test]
fn usdc_in_by_cctp_is_the_holders_and_leaves_by_cctp_without_naming_them() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");

    // The filled note is spendable by its owner's key: a proven invoke spends
    // it through the exit to a (different) Ethereum address.
    let out: u128 = 40_000_000;
    let msg = exit_to(env, out, OTHER_EVM);
    let burn = env.messenger.last_burn();
    assert(burn.caller == env.exit, 'burned by the exit');
    assert(burn.amount == out.into(), 'amount');
    assert(burn.destination_domain == ETHEREUM_DOMAIN, 'to Ethereum');
    assert(burn.mint_recipient == OTHER_EVM, 'recipient');
    assert(burn.destination_caller == 0, 'anyone relays');
    assert(burn.min_finality_threshold == STANDARD_FINALITY, 'standard');
    assert(note_value(env, msg.open_note_id) == TWO_POW_128 + 1, 'change unit in the open note');
    assert(balance(env.usdc, env.exit) == 0, 'nothing left in the exit');
    assert(
        balance(env.usdc, env.pool.contract_address) == (AMOUNT - out).into(), 'rest in the pool',
    );
}

#[test]
#[should_panic(expected: 'ONLY_POOL')]
fn only_the_pool_invokes_the_exit() {
    let env = setup();
    IVeilCashExitDispatcher { contract_address: env.exit }
        .privacy_invoke(1, AMOUNT, OTHER_EVM, 0, STANDARD_FINALITY);
}

#[test]
#[should_panic(expected: 'BAD_RECIPIENT')]
fn the_exit_pays_only_an_evm_address() {
    let env = setup();
    start_cheat_caller_address(env.exit, env.pool.contract_address);
    IVeilCashExitDispatcher { contract_address: env.exit }
        .privacy_invoke(1, AMOUNT, 0x10000000000000000000000000000000000000000, 0, STANDARD_FINALITY);
}

#[test]
#[should_panic(expected: 'USDC_NOT_RECEIVED')]
fn the_exit_burns_only_what_the_pool_paid_it() {
    let env = setup();
    start_cheat_caller_address(env.exit, env.pool.contract_address);
    IVeilCashExitDispatcher { contract_address: env.exit }
        .privacy_invoke(1, AMOUNT, OTHER_EVM, 0, STANDARD_FINALITY);
}

#[test]
#[should_panic]
fn a_retry_under_circles_pause_reverts() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    // Held because the pool was paused when the USDC arrived.
    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.pause();
    stop_cheat_caller_address(env.pool.contract_address);
    let id = env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    start_cheat_caller_address(env.pool.contract_address, owner());
    env.pool.unpause();
    stop_cheat_caller_address(env.pool.contract_address);
    // Circle pauses USDC: the fill's transfer is refused, so the retry reverts.
    IMockCashTokenDispatcher { contract_address: env.usdc }.set_paused(true);
    env.vault.retry_delivery(id);
}

// ── USDC's own rules in the pool ─────────────────────────────────────────────

#[test]
fn the_pool_reads_circles_pause_and_blocklist_and_nothing_else() {
    let env = setup();
    let rules = ITransferRulesDispatcher { contract_address: env.rules };
    let usdc = IMockCashTokenDispatcher { contract_address: env.usdc };
    assert(rules.can_hold(holder()) && !rules.is_frozen(holder()), 'anyone Circle allows');
    assert(!rules.is_paused() && rules.transfers_enabled(), 'open');
    assert(rules.can_transfer(holder(), stranger(), AMOUNT.into()), 'transfer');
    assert(!rules.requires_full_balance(holder(), stranger()), 'no full-balance rule');
    assert(rules.locked_amount(holder()) == 0, 'no locks');
    assert(!rules.new_investor_capped(holder(), stranger()), 'no cap');
    assert(rules.min_residual(holder(), stranger()) == (0, false), 'no minimum');

    usdc.set_blocklisted(stranger(), true);
    assert(!rules.can_hold(stranger()) && rules.is_frozen(stranger()), 'blocklist = freeze');
    assert(!rules.can_transfer(holder(), stranger(), 1), 'no transfer to it');
    assert(!rules.can_transfer(stranger(), holder(), 1), 'no transfer from it');
    usdc.set_paused(true);
    assert(rules.is_paused(), 'pause');
}

#[test]
#[should_panic(expected: 'FROZEN_BY_ISSUER')]
fn a_blocklisted_holder_cannot_move_usdc_out_of_the_pool() {
    let env = setup();
    let note = create_open_note(env.pool, holder(), KEY, env.usdc);
    env.vault.receive_deposit(deposit_message(env, 1, note, AMOUNT, BUYER_EVM), "ATTESTED");
    IMockCashTokenDispatcher { contract_address: env.usdc }.set_blocklisted(holder(), true);
    exit_to(env, 10_000_000, OTHER_EVM);
}

