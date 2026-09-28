// The two permissioned ERC-20 kinds besides ERC-3643, end to end on the real
// Veil pool, held by an EVM wallet with no Starknet account:
//
//   - an ALLOWLISTED twin is listed as an allowlisted token, with the mirrored
//     registry as its permission manager: a holder is allowed exactly when the
//     mirror verifies it (`has_role`);
//   - a RULE-GATED twin is listed as a rules token, with `VeilMirroredRules`
//     answering the pool's `ITransferRules` from the issuer's rules the
//     lockbox mirrors (HOLDER_RULES, TOKEN_RULES).
//
// The wire vectors are the ones `evm/test/kinds.test.js` pins on the EVM side.

use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil::interfaces::IVeilERC3643::{IVeilERC3643Dispatcher, IVeilERC3643DispatcherTrait};
use veil_bridge::bridged_token::{IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait};
use veil_bridge::gateway::{IVeilBridgeGatewayDispatcher, IVeilBridgeGatewayDispatcherTrait};
use veil_bridge::lz::{Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, Origin};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};
use veil_bridge::mirrored_rules::{IVeilMirroredRulesDispatcher, IVeilMirroredRulesDispatcherTrait};
use veil_bridge::mocks::{
    IMockEndpointExtDispatcher, IMockEndpointExtDispatcherTrait, IMockNativeTokenExtDispatcher,
    IMockNativeTokenExtDispatcherTrait,
};
use veil_bridge::msg_codec::{
    HolderRulesMessage, IdentitySnapshot, MintMessage, TokenRulesMessage, decode_holder_rules,
    decode_token_rules, encode_holder_rules, encode_identity, encode_mint, encode_token_rules,
    encode_unlock,
};
use super::proof::{create_open_note, curve_x, evm_holder, invoke, note_id, register, self_channel_key, virtual_tx};

const EVM_EID: u32 = 40161;
const KEY: felt252 = 0x7E5;
const AMOUNT: u128 = 1_000;
const TWO_POW_128: felt252 = 0x100000000000000000000000000000000;
const FEE: u256 = 5_000;
const EVM_RECIPIENT: felt252 = 0x1111111111111111111111111111111111111111;
const WINDOW: u64 = 1_000;
const ROLE: felt252 = 'WHITELISTED_ROLE';

fn owner() -> ContractAddress {
    0x0A11.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    0x5EE.try_into().unwrap()
}
fn peer() -> Bytes32 {
    Bytes32 { value: 0x10CCB0C5 }
}

#[derive(Drop, Copy, PartialEq)]
enum Kind {
    Allowlist,
    Rules,
}

#[derive(Drop, Copy)]
struct Env {
    pool: IVeilERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    registry: IVeilMirroredRegistryDispatcher,
    rules: IVeilMirroredRulesDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    endpoint: IMockEndpointExtDispatcher,
}

fn deploy(name: ByteArray, calldata: Array<felt252>) -> ContractAddress {
    let (address, _) = declare(name).unwrap().contract_class().deploy(@calldata).unwrap();
    address
}

// A bridge pool as deployed for each kind: the twin listed under its kind, the
// gateway an allowed adapter, the pool and the gateway local identities in the
// mirror. Records expire after WINDOW seconds.
fn setup(kind: Kind) -> Env {
    virtual_tx();
    start_cheat_block_timestamp_global(100);
    let native = deploy("MockNativeToken", array![]);
    let endpoint = deploy("MockLzEndpoint", array![]);
    let registry = deploy("VeilMirroredRegistry", array![owner().into(), WINDOW.into()]);
    let gateway = deploy(
        "VeilBridgeGateway",
        array![owner().into(), endpoint.into(), native.into(), registry.into(), EVM_EID.into()],
    );
    let mut args: Array<felt252> = array![];
    let name: ByteArray = "Bridged Fund";
    let symbol: ByteArray = "bFUND";
    name.serialize(ref args);
    symbol.serialize(ref args);
    args.append(owner().into());
    args.append(registry.into());
    args.append(0);
    let token = deploy("VeilBridgedERC3643", args);
    let pool = deploy("VeilERC3643", array![owner().into(), owner().into(), curve_x(77), 0]);
    let rules = deploy("VeilMirroredRules", array![owner().into(), registry.into()]);

    let r = IVeilMirroredRegistryDispatcher { contract_address: registry };
    start_cheat_caller_address(registry, owner());
    r.set_gateway(gateway);
    r.set_local_identity(pool, true, 840);
    r.set_local_identity(gateway, true, 840);
    stop_cheat_caller_address(registry);

    let t = IVeilBridgedERC3643Dispatcher { contract_address: token };
    start_cheat_caller_address(token, owner());
    t.set_gateway(gateway);
    stop_cheat_caller_address(token);

    let g = IVeilBridgeGatewayDispatcher { contract_address: gateway };
    start_cheat_caller_address(gateway, owner());
    g.set_token(token);
    g.set_peer(EVM_EID, peer());
    g.set_pool(pool);
    if kind == Kind::Rules {
        g.set_rules(rules);
    }
    stop_cheat_caller_address(gateway);

    let m = IVeilMirroredRulesDispatcher { contract_address: rules };
    start_cheat_caller_address(rules, owner());
    m.set_gateway(gateway);
    stop_cheat_caller_address(rules);

    let p = IVeilERC3643Dispatcher { contract_address: pool };
    let verifier = *declare("VeilEvmVerifier").unwrap().contract_class().class_hash;
    start_cheat_caller_address(pool, owner());
    match kind {
        Kind::Allowlist => p.add_allowlisted_token(token, registry, ROLE),
        Kind::Rules => p.add_rules_token(token, rules),
    }
    p.set_adapter_allowed(gateway, true);
    p.set_evm_verifier(verifier);
    stop_cheat_caller_address(pool);

    let e = IMockEndpointExtDispatcher { contract_address: endpoint };
    e.set_fee(FEE, 0);
    IMockNativeTokenExtDispatcher { contract_address: native }.mint(gateway, 100 * FEE);

    Env { pool: p, gateway: g, registry: r, rules: m, token: t, endpoint: e }
}

fn receive(env: Env, message: ByteArray, nonce: u64) {
    let receiver = ILayerZeroReceiverDispatcher { contract_address: env.gateway.contract_address };
    start_cheat_caller_address(receiver.contract_address, env.gateway.get_endpoint());
    receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce },
            Bytes32 { value: nonce.into() },
            message,
            stranger(),
            Default::default(),
            0,
        );
    stop_cheat_caller_address(receiver.contract_address);
}

fn sync(env: Env, account: ContractAddress, seq: u64, verified: bool) {
    let s = IdentitySnapshot { evm_account: account.into(), seq, verified, frozen: false, country: 0 };
    receive(env, encode_identity(s), seq);
}

fn holder_rules(env: Env, account: ContractAddress, seq: u64, can_hold: bool, locked: u256) {
    let msg = HolderRulesMessage {
        evm_account: account.into(), seq, can_hold, frozen: false, is_investor: true, locked,
    };
    receive(env, encode_holder_rules(msg), seq);
}

fn token_rules(env: Env, seq: u64, transfers_enabled: bool) {
    let msg = TokenRulesMessage {
        seq,
        transfers_enabled,
        investor_cap_reached: false,
        full_balance_required: false,
        min_holding_strict: false,
        min_holding: 0,
    };
    receive(env, encode_token_rules(msg), seq);
}

fn bridge_in(env: Env, account: ContractAddress, note: felt252, seq: u64) {
    let msg = MintMessage {
        identity: IdentitySnapshot { evm_account: account.into(), seq, verified: true, frozen: false, country: 0 },
        sn_recipient: account,
        amount: AMOUNT.into(),
        note_id: note,
        pool: 0.try_into().unwrap(),
    };
    receive(env, encode_mint(msg), seq);
}

fn note_value(env: Env, note: felt252) -> felt252 {
    (*env.pool.get_notes_batch(array![note]).at(0)).encrypted_amount
}

/// The EVM wallet, eligible under its kind, holding AMOUNT in its own note.
fn funded(kind: Kind) -> (Env, felt252) {
    let env = setup(kind);
    sync(env, evm_holder(), 1, true);
    if kind == Kind::Rules {
        holder_rules(env, evm_holder(), 2, true, 0);
        token_rules(env, 1, true);
    }
    register(env.pool, evm_holder(), KEY);
    let note = create_open_note(env.pool, evm_holder(), KEY, env.token.contract_address);
    bridge_in(env, evm_holder(), note, 10);
    (env, note)
}

fn free_slot(env: Env) -> u32 {
    let key = self_channel_key(evm_holder(), KEY);
    let mut i: u32 = 0;
    while note_value(env, note_id(key, env.token.contract_address, i)) != 0 {
        i += 1;
    }
    i
}

/// The wallet's proven exit of `amount` back to Ethereum.
fn exit(env: Env, amount: u128) {
    let token = env.token.contract_address;
    let open_note = note_id(self_channel_key(evm_holder(), KEY), token, free_slot(env) + 1);
    let calldata = array![open_note, amount.into(), EVM_RECIPIENT, FEE.low.into(), FEE.high.into(), 200_000];
    invoke(env.pool, evm_holder(), KEY, token, amount + 1, token, env.gateway.contract_address, calldata);
}

// ── Wire format ─────────────────────────────────────────────────────────────

#[test]
fn holder_rules_decode_the_bytes_the_lockbox_sends() {
    let msg = HolderRulesMessage {
        evm_account: 0xb0b, seq: 7, can_hold: true, frozen: false, is_investor: true, locked: 42,
    };
    let bytes = encode_holder_rules(msg);
    assert(bytes.len() == 76, 'length');
    assert(bytes.at(0).unwrap() == 5, 'kind');
    assert(bytes.at(31).unwrap() == 0x0b && bytes.at(32).unwrap() == 0x0b, 'account');
    assert(bytes.at(40).unwrap() == 7, 'seq');
    assert(bytes.at(41).unwrap() == 1 && bytes.at(42).unwrap() == 0 && bytes.at(43).unwrap() == 1, 'flags');
    assert(bytes.at(75).unwrap() == 42, 'locked');
    assert(decode_holder_rules(@bytes) == msg, 'round trip');
}

#[test]
fn token_rules_decode_the_bytes_the_lockbox_sends() {
    let msg = TokenRulesMessage {
        seq: 3,
        transfers_enabled: true,
        investor_cap_reached: false,
        full_balance_required: true,
        min_holding_strict: false,
        min_holding: 1000,
    };
    let bytes = encode_token_rules(msg);
    assert(bytes.len() == 45, 'length');
    assert(bytes.at(0).unwrap() == 6 && bytes.at(8).unwrap() == 3, 'kind, seq');
    assert(bytes.at(9).unwrap() == 1 && bytes.at(10).unwrap() == 0, 'flags a');
    assert(bytes.at(11).unwrap() == 1 && bytes.at(12).unwrap() == 0, 'flags b');
    assert(bytes.at(43).unwrap() == 0x03 && bytes.at(44).unwrap() == 0xe8, 'min holding');
    assert(decode_token_rules(@bytes) == msg, 'round trip');
}

#[test]
#[should_panic(expected: 'BRIDGE_BAD_LENGTH')]
fn a_truncated_rules_message_is_refused() {
    let mut bytes = encode_holder_rules(
        HolderRulesMessage { evm_account: 1, seq: 1, can_hold: true, frozen: false, is_investor: false, locked: 0 },
    );
    bytes.append_byte(0);
    decode_holder_rules(@bytes);
}

// ── Allowlisted ─────────────────────────────────────────────────────────────

#[test]
fn the_mirror_answers_the_allowlist_from_its_records() {
    let env = setup(Kind::Allowlist);
    assert(!env.registry.has_role(ROLE, evm_holder()), 'allowed before sync');
    sync(env, evm_holder(), 1, true);
    assert(env.registry.has_role(ROLE, evm_holder()), 'not allowed');
    sync(env, evm_holder(), 2, false);
    assert(!env.registry.has_role(ROLE, evm_holder()), 'still allowed after removal');
    assert(env.registry.has_role(ROLE, env.pool.contract_address), 'pool');
}

#[test]
fn an_allowed_wallet_bridges_in_and_back() {
    let (env, note) = funded(Kind::Allowlist);
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'note not filled');
    exit(env, 600);
    assert(env.endpoint.last_message() == encode_unlock(EVM_RECIPIENT, 600), 'unlock');
}

#[test]
#[should_panic(expected: 'NOT_WHITELISTED')]
fn a_wallet_off_the_list_cannot_open_a_note() {
    let env = setup(Kind::Allowlist);
    sync(env, evm_holder(), 1, false);
    register(env.pool, evm_holder(), KEY);
    create_open_note(env.pool, evm_holder(), KEY, env.token.contract_address);
}

#[test]
#[should_panic(expected: 'NOT_WHITELISTED')]
fn a_wallet_removed_from_the_list_cannot_move_its_position() {
    let (env, _) = funded(Kind::Allowlist);
    sync(env, evm_holder(), 11, false);
    exit(env, 600);
}

#[test]
#[should_panic(expected: 'NOT_WHITELISTED')]
fn an_allowlist_record_expires_closed() {
    let (env, _) = funded(Kind::Allowlist);
    start_cheat_block_timestamp_global(100 + WINDOW + 1);
    exit(env, 600);
}

// ── Rule-gated ──────────────────────────────────────────────────────────────

#[test]
fn a_wallet_under_the_issuer_rules_bridges_in_and_back() {
    let (env, note) = funded(Kind::Rules);
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'note not filled');
    exit(env, 600);
    assert(env.endpoint.last_message() == encode_unlock(EVM_RECIPIENT, 600), 'unlock');
}

#[test]
#[should_panic(expected: 'NOT_APPROVED')]
fn without_the_issuer_rules_a_wallet_cannot_open_a_note() {
    let env = setup(Kind::Rules);
    sync(env, evm_holder(), 1, true);
    token_rules(env, 1, true);
    register(env.pool, evm_holder(), KEY);
    create_open_note(env.pool, evm_holder(), KEY, env.token.contract_address);
}

#[test]
#[should_panic(expected: 'TOKENS_LOCKED')]
fn locked_tokens_stay_in_the_pool() {
    let (env, _) = funded(Kind::Rules);
    // The issuer locks 600 of the 1,000: at most 400 may leave.
    holder_rules(env, evm_holder(), 11, true, 600);
    exit(env, 600);
}

#[test]
fn the_free_part_of_a_locked_position_leaves() {
    let (env, _) = funded(Kind::Rules);
    holder_rules(env, evm_holder(), 11, true, 600);
    exit(env, 300);
    assert(env.endpoint.last_message() == encode_unlock(EVM_RECIPIENT, 300), 'unlock');
}

#[test]
#[should_panic(expected: 'TRANSFERS_DISABLED')]
fn the_issuer_switch_stops_every_movement() {
    let (env, _) = funded(Kind::Rules);
    token_rules(env, 2, false);
    exit(env, 600);
}

#[test]
#[should_panic(expected: 'NOT_APPROVED')]
fn stale_rules_fail_closed() {
    let (env, _) = funded(Kind::Rules);
    start_cheat_block_timestamp_global(100 + WINDOW + 1);
    // The identity and token records expire with the holder rules; refresh the
    // two that are not under test, so only the holder rules are stale.
    sync(env, evm_holder(), 20, true);
    token_rules(env, 21, true);
    exit(env, 600);
}

#[test]
fn stale_holder_rules_read_as_fully_locked_and_unable_to_hold() {
    let (env, _) = funded(Kind::Rules);
    assert(env.rules.locked_amount(evm_holder()) == 0, 'fresh lock');
    start_cheat_block_timestamp_global(100 + WINDOW + 1);
    assert(!env.rules.can_hold(evm_holder()), 'stale can hold');
    assert(env.rules.locked_amount(evm_holder()) == core::num::traits::Bounded::MAX, 'stale lock');
    assert(!env.rules.transfers_enabled(), 'stale token rules');
}

#[test]
fn infrastructure_is_exempt_from_the_investor_rules() {
    let env = setup(Kind::Rules);
    let pool = env.pool.contract_address;
    let gateway = env.gateway.contract_address;
    assert(env.rules.can_hold(gateway), 'gateway holds');
    assert(env.rules.locked_amount(pool) == 0, 'pool unlocked');
    assert(!env.rules.requires_full_balance(pool, gateway), 'full');
    let (min, strict) = env.rules.min_residual(pool, gateway);
    assert(min == 0 && !strict, 'residual');
}

#[test]
fn the_investor_cap_admits_a_new_investor_only_on_an_exit() {
    let env = setup(Kind::Rules);
    let newcomer: ContractAddress = 0x2222222222222222222222222222222222222222.try_into().unwrap();
    sync(env, evm_holder(), 1, true);
    sync(env, newcomer, 2, true);
    holder_rules(env, evm_holder(), 3, true, 0);
    receive(
        env,
        encode_holder_rules(
            HolderRulesMessage {
                evm_account: newcomer.into(), seq: 4, can_hold: true, frozen: false, is_investor: false, locked: 0,
            },
        ),
        4,
    );
    receive(
        env,
        encode_token_rules(
            TokenRulesMessage {
                seq: 1,
                transfers_enabled: true,
                investor_cap_reached: true,
                full_balance_required: false,
                min_holding_strict: false,
                min_holding: 0,
            },
        ),
        5,
    );
    assert(env.rules.new_investor_capped(evm_holder(), newcomer), 'cap to a newcomer');
    assert(!env.rules.new_investor_capped(newcomer, evm_holder()), 'cap to an investor');
}

#[test]
fn out_of_order_rules_are_dropped() {
    let env = setup(Kind::Rules);
    holder_rules(env, evm_holder(), 5, true, 7);
    holder_rules(env, evm_holder(), 4, false, 0);
    let r = env.rules.holder_rules(evm_holder().into());
    assert(r.seq == 5 && r.can_hold && r.locked == 7, 'older record applied');
}

#[test]
fn a_rules_message_binds_an_evm_wallet_to_itself() {
    let env = setup(Kind::Rules);
    holder_rules(env, evm_holder(), 1, true, 0);
    let own: felt252 = evm_holder().into();
    assert(env.registry.identity_of(evm_holder()) == own, 'not bound to itself');
}

#[test]
#[should_panic(expected: 'RULES_UNSET')]
fn a_rules_message_for_an_asset_without_rules_reverts() {
    let env = setup(Kind::Allowlist);
    holder_rules(env, evm_holder(), 1, true, 0);
}

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn only_the_gateway_writes_the_rules() {
    let env = setup(Kind::Rules);
    env.rules.apply_holder_rules(evm_holder().into(), 1, true, false, true, 0);
}
