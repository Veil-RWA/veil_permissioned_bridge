// A Stellar wallet as the holder, end to end, with no Starknet account anywhere.
//
// The gateway's lockbox is on Stellar (account format STELLAR): every account
// word in a message is a Stellar account's raw Ed25519 key, and its holder in
// the real VeilERC3643 pool is `stellar_holder(key)`, which signs its proofs
// with SEP-53 Ed25519 signatures (veil's VeilStellarVerifier).
//   in:   the wallet's record arrives (a sync or its own bridge-out) and binds
//         its holder to itself; the wallet opens a note; its own bridge-out
//         names the note, which claims and fills it;
//   out:  a proven pool `invoke` pays the gateway, which burns the twin and asks
//         the lockbox to release it to a Stellar key, named by its handle.

use core::poseidon::poseidon_hash_span;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::{ClassHash, ContractAddress};
use veil::interfaces::IVeilERC3643::{IVeilERC3643Dispatcher, IVeilERC3643DispatcherTrait, InvokeSwap};
use veil_bridge::bridged_token::{IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait};
use veil_bridge::bytes::{append_bool, append_u16, append_u256, append_u64, append_u8};
use veil_bridge::gateway::{IVeilBridgeGatewayDispatcher, IVeilBridgeGatewayDispatcherTrait};
use veil_bridge::lz::{Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, Origin};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};
use veil_bridge::mocks::{
    IMockEndpointExtDispatcher, IMockEndpointExtDispatcherTrait, IMockNativeTokenExtDispatcher,
    IMockNativeTokenExtDispatcherTrait,
};
use veil_bridge::msg_codec::{
    KIND_HOLDER_RULES, KIND_IDENTITY, KIND_MINT, decode_holder_rules_as, decode_identity_as,
    decode_mint_as, encode_unlock_word,
};
use veil_bridge::stellar::{
    ACCOUNT_FORMAT_EVM, ACCOUNT_FORMAT_STELLAR, TWO_POW_249, is_stellar_wallet, recipient_handle,
    stellar_holder as bridge_holder,
};
use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use super::proof::{
    STELLAR_PK, create_open_note, curve_x, evm_holder, invoke, note_id, register, self_channel_key,
    stellar_holder, virtual_tx,
};

/// LayerZero's Stellar testnet endpoint id (metadata API: 40600; mainnet 30600).
const STELLAR_EID: u32 = 40600;
const KEY: felt252 = 0x7E5;
const AMOUNT: u128 = 1_000;
const TWO_POW_128: felt252 = 0x100000000000000000000000000000000;
const FEE: u256 = 5_000;
/// Another Stellar account (seed 32 x 0x09), the sender of gifts.
const OTHER_PK: u256 = 0xfd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618;
/// Where the holder takes its tokens back to on Stellar: any account key.
const EXIT_KEY: u256 = 0x3cb2a5f4c3e1d2b0a9988776655443322110ffeeddccbbaa9988776655443322;

fn owner() -> ContractAddress {
    0x0A11.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    0x5EE.try_into().unwrap()
}
/// The Soroban lockbox: a contract id, 32 bytes.
fn peer() -> Bytes32 {
    Bytes32 { value: 0x5701ab0c5701ab0c5701ab0c5701ab0c5701ab0c5701ab0c5701ab0c5701ab0c }
}

#[derive(Drop, Copy)]
struct Env {
    pool: IVeilERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    endpoint: IMockEndpointExtDispatcher,
    native: ContractAddress,
}

fn deploy(name: ByteArray, calldata: Array<felt252>) -> ContractAddress {
    let (address, _) = declare(name).unwrap().contract_class().deploy(@calldata).unwrap();
    address
}

fn stellar_verifier() -> ClassHash {
    *declare("VeilStellarVerifier").unwrap().contract_class().class_hash
}

// As test_evm_holder's bridge pool, with the gateway in Stellar format and the
// pool and gateway both knowing the Stellar verifier.
fn setup() -> Env {
    virtual_tx();
    start_cheat_block_timestamp_global(100);
    let native = deploy("MockNativeToken", array![]);
    let endpoint = deploy("MockLzEndpoint", array![]);
    let registry = deploy("VeilMirroredRegistry", array![owner().into(), 0]);
    let gateway = deploy(
        "VeilBridgeGateway",
        array![owner().into(), endpoint.into(), native.into(), registry.into(), STELLAR_EID.into()],
    );
    let mut args: Array<felt252> = array![];
    let name: ByteArray = "Bridged Stellar Asset";
    let symbol: ByteArray = "bSAC";
    name.serialize(ref args);
    symbol.serialize(ref args);
    args.append(owner().into());
    args.append(registry.into());
    args.append(0);
    let token = deploy("VeilBridgedERC3643", args);
    let pool = deploy("VeilERC3643", array![owner().into(), owner().into(), curve_x(77), 0]);

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

    let verifier = stellar_verifier();
    let g = IVeilBridgeGatewayDispatcher { contract_address: gateway };
    start_cheat_caller_address(gateway, owner());
    g.set_account_format(ACCOUNT_FORMAT_STELLAR);
    g.set_stellar_verifier(verifier);
    g.set_token(token);
    g.set_peer(STELLAR_EID, peer());
    g.set_pool(pool);
    stop_cheat_caller_address(gateway);

    let p = IVeilERC3643Dispatcher { contract_address: pool };
    start_cheat_caller_address(pool, owner());
    p.add_token(token, registry, 0.try_into().unwrap());
    p.set_adapter_allowed(gateway, true);
    p.set_stellar_verifier(verifier);
    stop_cheat_caller_address(pool);

    let e = IMockEndpointExtDispatcher { contract_address: endpoint };
    e.set_fee(FEE, 0);
    IMockNativeTokenExtDispatcher { contract_address: native }.mint(gateway, 100 * FEE);

    Env { pool: p, gateway: g, registry: r, token: t, endpoint: e, native }
}

fn receive(env: Env, message: ByteArray, nonce: u64) {
    let receiver = ILayerZeroReceiverDispatcher { contract_address: env.gateway.contract_address };
    start_cheat_caller_address(receiver.contract_address, env.gateway.get_endpoint());
    receiver
        .lz_receive(
            Origin { src_eid: STELLAR_EID, sender: peer(), nonce },
            Bytes32 { value: nonce.into() },
            message,
            stranger(),
            Default::default(),
            0,
        );
    stop_cheat_caller_address(receiver.contract_address);
}

// The Soroban lockbox's IDENTITY for a Stellar account (its raw key).
fn identity_msg(key: u256, seq: u64, verified: bool, frozen: bool) -> ByteArray {
    let mut out: ByteArray = Default::default();
    append_u8(ref out, KIND_IDENTITY);
    append_u256(ref out, key);
    append_u64(ref out, seq);
    append_bool(ref out, verified);
    append_bool(ref out, frozen);
    append_u16(ref out, 0);
    out
}

// The Soroban lockbox's MINT: `bridge_out` from `sender_key` to `recipient`.
fn mint_msg(sender_key: u256, recipient: ContractAddress, note: felt252, seq: u64) -> ByteArray {
    let mut out: ByteArray = Default::default();
    append_u8(ref out, KIND_MINT);
    append_u256(ref out, sender_key);
    let r: felt252 = recipient.into();
    append_u256(ref out, r.into());
    append_u256(ref out, AMOUNT.into());
    append_u64(ref out, seq);
    append_bool(ref out, true);
    append_bool(ref out, false);
    append_u16(ref out, 0);
    append_u256(ref out, note.into());
    append_u256(ref out, 0);
    out
}

fn sync(env: Env, key: u256, seq: u64) {
    receive(env, identity_msg(key, seq, true, false), seq);
}

fn bridge_in(env: Env, sender_key: u256, recipient: ContractAddress, note: felt252, seq: u64) {
    receive(env, mint_msg(sender_key, recipient, note, seq), seq);
}

fn balance(token: ContractAddress, holder: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }.balance_of(holder)
}

fn note_value(env: Env, note: felt252) -> felt252 {
    (*env.pool.get_notes_batch(array![note]).at(0)).encrypted_amount
}

fn funded() -> (Env, felt252) {
    let env = setup();
    sync(env, STELLAR_PK, 1);
    register(env.pool, stellar_holder(), KEY);
    let note = create_open_note(env.pool, stellar_holder(), KEY, env.token.contract_address);
    bridge_in(env, STELLAR_PK, stellar_holder(), note, 2);
    (env, note)
}

fn free_slot(env: Env) -> u32 {
    let key = self_channel_key(stellar_holder(), KEY);
    let mut i: u32 = 0;
    while note_value(env, note_id(key, env.token.contract_address, i)) != 0 {
        i += 1;
    }
    i
}

fn exit(env: Env, amount: u128, recipient: felt252, max_fee: u256) -> InvokeSwap {
    let token = env.token.contract_address;
    let open_note = note_id(self_channel_key(stellar_holder(), KEY), token, free_slot(env) + 1);
    let calldata = array![
        open_note, amount.into(), recipient, max_fee.low.into(), max_fee.high.into(), 200_000,
    ];
    invoke(
        env.pool, stellar_holder(), KEY, token, amount + 1, token, env.gateway.contract_address,
        calldata,
    )
}

// ── The holder and the codec ────────────────────────────────────────────────

#[test]
fn the_bridge_derives_the_same_holder_as_the_pool() {
    let pool_side = veil::helpers::stellar_signature::stellar_holder(STELLAR_PK);
    assert(bridge_holder(STELLAR_PK) == pool_side, 'bridge != pool holder');
    assert(
        bridge_holder(OTHER_PK) == veil::helpers::stellar_signature::stellar_holder(OTHER_PK),
        'other',
    );
    let h: felt252 = stellar_holder().into();
    let h: u256 = h.into();
    assert(h >= TWO_POW_249, 'below 2^249');
    assert(is_stellar_wallet(stellar_holder()), 'not a stellar wallet');
}

#[test]
fn a_stellar_lockbox_message_names_accounts_by_key() {
    let id = decode_identity_as(@identity_msg(STELLAR_PK, 9, true, false), ACCOUNT_FORMAT_STELLAR);
    assert(id.evm_account == stellar_holder().into(), 'identity is the holder');
    assert(id.seq == 9 && id.verified && !id.frozen, 'fields');
    let m = decode_mint_as(@mint_msg(OTHER_PK, stellar_holder(), 0xBEEF, 4), ACCOUNT_FORMAT_STELLAR);
    assert(m.identity.evm_account == bridge_holder(OTHER_PK).into(), 'sender holder');
    assert(m.sn_recipient == stellar_holder(), 'recipient');
    assert(m.amount == AMOUNT.into() && m.note_id == 0xBEEF, 'amount / note');
    let mut rules: ByteArray = Default::default();
    append_u8(ref rules, KIND_HOLDER_RULES);
    append_u256(ref rules, STELLAR_PK);
    append_u64(ref rules, 3);
    append_bool(ref rules, true);
    append_bool(ref rules, false);
    append_bool(ref rules, false);
    append_u256(ref rules, 0);
    let r = decode_holder_rules_as(@rules, ACCOUNT_FORMAT_STELLAR);
    assert(r.evm_account == stellar_holder().into() && r.can_hold, 'rules');
    // UNLOCK carries the whole 32-byte key.
    let unlock = encode_unlock_word(EXIT_KEY, 600);
    assert(unlock.len() == 65, 'unlock length');
    assert(unlock.at(0).unwrap() == 4, 'unlock kind');
    assert(unlock.at(1).unwrap() == 0x3c && unlock.at(32).unwrap() == 0x22, 'key bytes');
}

// The same 32-byte word an EVM gateway refuses as a dirty address.
#[test]
#[should_panic(expected: 'BRIDGE_BAD_EVM_ADDR')]
fn an_evm_gateway_refuses_a_stellar_key() {
    decode_identity_as(@identity_msg(STELLAR_PK, 1, true, false), ACCOUNT_FORMAT_EVM);
}

#[test]
#[should_panic(expected: 'BRIDGE_BAD_STELLAR_KEY')]
fn a_zero_stellar_key_is_refused() {
    decode_identity_as(@identity_msg(0, 1, true, false), ACCOUNT_FORMAT_STELLAR);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected: 'FORMAT_ALREADY_SET')]
fn the_account_format_is_set_once() {
    let env = setup();
    assert(env.gateway.account_format() == ACCOUNT_FORMAT_STELLAR, 'format');
    start_cheat_caller_address(env.gateway.contract_address, owner());
    env.gateway.set_account_format(ACCOUNT_FORMAT_EVM);
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn only_the_owner_sets_the_account_format() {
    let env = setup();
    env.gateway.set_account_format(ACCOUNT_FORMAT_STELLAR);
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn only_the_owner_sets_the_stellar_verifier() {
    let env = setup();
    env.gateway.set_stellar_verifier(stellar_verifier());
}

// ── In ──────────────────────────────────────────────────────────────────────

#[test]
fn a_synced_stellar_wallet_holds_as_itself() {
    let env = setup();
    assert(!env.registry.is_verified(stellar_holder()), 'verified before sync');
    sync(env, STELLAR_PK, 1);
    let own: felt252 = stellar_holder().into();
    assert(env.registry.identity_of(stellar_holder()) == own, 'not bound to itself');
    assert(env.registry.is_verified(stellar_holder()), 'not verified');
}

#[test]
fn a_frozen_stellar_account_is_not_verified() {
    let env = setup();
    sync(env, STELLAR_PK, 1);
    receive(env, identity_msg(STELLAR_PK, 2, true, true), 2);
    assert(!env.registry.is_verified(stellar_holder()), 'still verified');
}

#[test]
fn a_stellar_wallet_bridging_to_itself_fills_its_own_note() {
    let (env, note) = funded();
    assert(env.gateway.note_owner(note) == stellar_holder(), 'note not claimed');
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'note not filled');
    assert(balance(env.token.contract_address, env.pool.contract_address) == AMOUNT.into(), 'pool');
}

#[test]
fn a_sender_cannot_tie_a_stellar_wallet_to_its_own_identity() {
    let env = setup();
    sync(env, OTHER_PK, 1);
    bridge_in(env, OTHER_PK, stellar_holder(), 0xBEEF, 2);
    let own: felt252 = stellar_holder().into();
    assert(env.registry.identity_of(stellar_holder()) == own, 'bound to the sender');
    assert(env.gateway.pending_of(stellar_holder()) == AMOUNT.into(), 'not held');
}

#[test]
fn a_held_amount_goes_only_into_a_note_the_wallet_signed_for() {
    let env = setup();
    sync(env, STELLAR_PK, 1);
    sync(env, OTHER_PK, 2);
    register(env.pool, stellar_holder(), KEY);
    let note = create_open_note(env.pool, stellar_holder(), KEY, env.token.contract_address);
    bridge_in(env, OTHER_PK, stellar_holder(), note, 3);
    assert(env.gateway.pending_of(stellar_holder()) == AMOUNT.into(), 'not held');

    let sig = super::stellar_vectors::stellar_sig(env.gateway.note_claim_hash(note));
    env.gateway.register_note_stellar(note, stellar_holder(), sig);
    assert(env.gateway.note_owner(note) == stellar_holder(), 'not claimed');
    env.gateway.claim_to_note(stellar_holder(), note, 0.try_into().unwrap());
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'not released');
}

#[test]
#[should_panic(expected: 'INVALID_SIGNATURE')]
fn another_key_cannot_claim_a_note_for_a_stellar_wallet() {
    let env = setup();
    let sig = super::stellar_vectors::other_key_sig(env.gateway.note_claim_hash(0xBEEF));
    env.gateway.register_note_stellar(0xBEEF, stellar_holder(), sig);
}

#[test]
#[should_panic(expected: 'NOT_A_STELLAR_WALLET')]
fn an_evm_wallet_cannot_claim_as_a_stellar_wallet() {
    let env = setup();
    env.gateway.register_note_stellar(0xBEEF, evm_holder(), array![1, 2, 3, 4, 5, 6]);
}

#[test]
#[should_panic(expected: 'STELLAR_VERIFIER_UNSET')]
fn without_a_verifier_no_stellar_claim() {
    let native = deploy("MockNativeToken", array![]);
    let endpoint = deploy("MockLzEndpoint", array![]);
    let registry = deploy("VeilMirroredRegistry", array![owner().into(), 0]);
    let gateway = deploy(
        "VeilBridgeGateway",
        array![owner().into(), endpoint.into(), native.into(), registry.into(), STELLAR_EID.into()],
    );
    let g = IVeilBridgeGatewayDispatcher { contract_address: gateway };
    g.register_note_stellar(0xBEEF, stellar_holder(), array![1, 2, 3, 4, 5, 6]);
}

// ── Out ─────────────────────────────────────────────────────────────────────

#[test]
fn a_stellar_recipient_is_named_by_its_handle() {
    let env = setup();
    let handle = env.gateway.register_stellar_recipient(EXIT_KEY);
    assert(handle == recipient_handle(EXIT_KEY), 'handle');
    assert(
        handle == poseidon_hash_span(
            array!['VEIL_STELLAR_RECIPIENT', EXIT_KEY.high.into(), EXIT_KEY.low.into()].span(),
        ),
        'handle formula',
    );
    assert(env.gateway.stellar_recipient(handle) == EXIT_KEY, 'lookup');
    // Idempotent, and anyone may register.
    start_cheat_caller_address(env.gateway.contract_address, stranger());
    assert(env.gateway.register_stellar_recipient(EXIT_KEY) == handle, 'again');
}

#[test]
fn a_stellar_wallet_bridges_back_through_a_proven_invoke() {
    let (env, _) = funded();
    let token = env.token.contract_address;
    let supply_before = IERC20Dispatcher { contract_address: token }.total_supply();
    let handle = env.gateway.register_stellar_recipient(EXIT_KEY);

    let out: u128 = 600;
    let msg = exit(env, out, handle, FEE);

    assert(env.endpoint.last_message() == encode_unlock_word(EXIT_KEY, out.into()), 'unlock');
    assert(env.endpoint.last_dst_eid() == STELLAR_EID, 'to stellar');
    assert(
        IERC20Dispatcher { contract_address: token }.total_supply() == supply_before - out.into(),
        'burned',
    );
    assert(note_value(env, msg.open_note_id) == TWO_POW_128 + 1, 'change in the open note');
    assert(balance(token, env.gateway.contract_address) == 0, 'left in the gateway');
    assert(balance(token, env.pool.contract_address) == (AMOUNT - out).into(), 'rest in pool');
    assert(env.endpoint.send_count() == 1, 'one LayerZero send');
}

#[test]
#[should_panic(expected: 'BAD_RECIPIENT')]
fn the_exit_pays_only_a_registered_stellar_key() {
    let env = setup();
    start_cheat_caller_address(env.gateway.contract_address, env.pool.contract_address);
    env.gateway.privacy_invoke(0xBEEF, 1, recipient_handle(EXIT_KEY), FEE, 200_000);
}

#[test]
#[should_panic(expected: 'BAD_RECIPIENT')]
fn a_starknet_bridge_back_needs_a_registered_stellar_key() {
    let env = setup();
    env.gateway.quote_bridge_back(10, 0x1234, 200_000);
}
