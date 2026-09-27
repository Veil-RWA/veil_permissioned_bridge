// An EVM wallet as the holder, end to end, with no Starknet account anywhere.
//
// The real VeilERC3643 pool, a bridge pool (deposit / withdraw closed), holds a
// twin for an EVM wallet that signs its proofs with its own secp256k1 key:
//   in:   the wallet's identity arrives (a sync or its own bridge-out) and binds
//         the address to itself; the wallet opens a note; its own bridge-out
//         names the note, which claims and fills it;
//   out:  a proven pool `invoke` pays the gateway, which burns the twin and asks
//         the lockbox to release it to an Ethereum address, paying LayerZero
//         from its own balance.

use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil::interfaces::IVeilERC3643::{
    IVeilERC3643Dispatcher, IVeilERC3643DispatcherTrait, InvokeSwap,
};
use veil_bridge::bridged_token::{IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait};
use veil_bridge::gateway::{IVeilBridgeGatewayDispatcher, IVeilBridgeGatewayDispatcherTrait};
use veil_bridge::lz::{Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, Origin};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};
use veil_bridge::mocks::{
    IMockEndpointExtDispatcher, IMockEndpointExtDispatcherTrait, IMockNativeTokenExtDispatcher,
    IMockNativeTokenExtDispatcherTrait,
};
use veil_bridge::msg_codec::{IdentitySnapshot, MintMessage, encode_identity, encode_mint, encode_unlock};
use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use super::proof::{
    EVM_HOLDER_SECRET, create_open_note, curve_x, evm_address_of, evm_holder, evm_personal_sign,
    invoke, note_id, register, self_channel_key, virtual_tx,
};

const EVM_EID: u32 = 40161;
const KEY: felt252 = 0x7E5;
const AMOUNT: u128 = 1_000;
const TWO_POW_128: felt252 = 0x100000000000000000000000000000000;
const FEE: u256 = 5_000;
/// Where the holder takes its tokens back to on Ethereum.
const EVM_RECIPIENT: felt252 = 0x1111111111111111111111111111111111111111;

fn owner() -> ContractAddress {
    0x0A11.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    0x5EE.try_into().unwrap()
}
fn peer() -> Bytes32 {
    Bytes32 { value: 0x10CCB0C5 }
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

// A bridge pool as deployed: the twin listed with its mirrored registry, the
// gateway an allowed adapter, the pool AND the gateway local identities in the
// mirror (the gateway holds the twin for the length of an exit). The gateway
// holds native token for exit fees. The pool's deposit / withdraw stay closed.
fn setup() -> Env {
    virtual_tx();
    start_cheat_block_timestamp_global(100);
    let native = deploy("MockNativeToken", array![]);
    let endpoint = deploy("MockLzEndpoint", array![]);
    let registry = deploy("VeilMirroredRegistry", array![owner().into(), 0]);
    let gateway = deploy(
        "VeilBridgeGateway",
        array![owner().into(), endpoint.into(), native.into(), registry.into(), EVM_EID.into()],
    );
    let mut args: Array<felt252> = array![];
    let name: ByteArray = "Bridged Gold";
    let symbol: ByteArray = "bXAU";
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

    let g = IVeilBridgeGatewayDispatcher { contract_address: gateway };
    start_cheat_caller_address(gateway, owner());
    g.set_token(token);
    g.set_peer(EVM_EID, peer());
    g.set_pool(pool);
    stop_cheat_caller_address(gateway);

    let p = IVeilERC3643Dispatcher { contract_address: pool };
    let verifier = *declare("VeilEvmVerifier").unwrap().contract_class().class_hash;
    start_cheat_caller_address(pool, owner());
    p.add_token(token, registry, 0.try_into().unwrap());
    p.set_adapter_allowed(gateway, true);
    p.set_evm_verifier(verifier);
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
            Origin { src_eid: EVM_EID, sender: peer(), nonce },
            Bytes32 { value: nonce.into() },
            message,
            stranger(),
            Default::default(),
            0,
        );
    stop_cheat_caller_address(receiver.contract_address);
}

fn snapshot(account: ContractAddress, seq: u64) -> IdentitySnapshot {
    IdentitySnapshot { evm_account: account.into(), seq, verified: true, frozen: false, country: 840 }
}

// The lockbox's `syncCompliance(wallet)`.
fn sync(env: Env, account: ContractAddress, seq: u64) {
    receive(env, encode_identity(snapshot(account, seq)), seq);
}

// `bridgeOut` from `sender` on Ethereum, to `recipient` here, into `note`.
fn bridge_in(
    env: Env, sender: ContractAddress, recipient: ContractAddress, note: felt252, seq: u64,
) {
    let msg = MintMessage {
        identity: snapshot(sender, seq),
        sn_recipient: recipient,
        amount: AMOUNT.into(),
        note_id: note,
        pool: 0.try_into().unwrap(),
    };
    receive(env, encode_mint(msg), seq);
}

fn balance(token: ContractAddress, holder: ContractAddress) -> u256 {
    IERC20Dispatcher { contract_address: token }.balance_of(holder)
}

fn note_value(env: Env, note: felt252) -> felt252 {
    (*env.pool.get_notes_batch(array![note]).at(0)).encrypted_amount
}

// The EVM wallet, eligible and registered, holding AMOUNT in a note it filled
// by bridging to itself.
fn funded() -> (Env, felt252) {
    let env = setup();
    sync(env, evm_holder(), 1);
    register(env.pool, evm_holder(), KEY);
    let note = create_open_note(env.pool, evm_holder(), KEY, env.token.contract_address);
    bridge_in(env, evm_holder(), evm_holder(), note, 2);
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

/// One proven invoke: `amount + 1` of the wallet's twin pays the gateway, which
/// burns `amount` to `EVM_RECIPIENT` and returns 1 to the invoke's note.
fn exit(env: Env, amount: u128, max_fee: u256) -> InvokeSwap {
    let token = env.token.contract_address;
    let open_note = note_id(self_channel_key(evm_holder(), KEY), token, free_slot(env) + 1);
    let calldata = array![
        open_note, amount.into(), EVM_RECIPIENT, max_fee.low.into(), max_fee.high.into(), 200_000,
    ];
    invoke(env.pool, evm_holder(), KEY, token, amount + 1, token, env.gateway.contract_address, calldata)
}

// ── In ──────────────────────────────────────────────────────────────────────

#[test]
fn a_synced_evm_wallet_holds_as_itself() {
    let env = setup();
    assert(!env.registry.is_verified(evm_holder()), 'verified before sync');
    sync(env, evm_holder(), 1);
    let own: felt252 = evm_holder().into();
    assert(env.registry.identity_of(evm_holder()) == own, 'not bound to itself');
    assert(env.registry.is_verified(evm_holder()), 'not verified');
}

#[test]
fn an_evm_wallet_bridging_to_itself_fills_its_own_note() {
    let (env, note) = funded();
    assert(env.gateway.note_owner(note) == evm_holder(), 'note not claimed');
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'note not filled');
    assert(balance(env.token.contract_address, env.pool.contract_address) == AMOUNT.into(), 'pool');
    assert(!env.pool.is_direct_access_enabled(), 'bridge pool is closed');
}

// Someone else bridging to an EVM wallet never binds that wallet to the
// sender's identity: it stays its own, and without its own record it cannot
// receive, so the amount is held for it.
#[test]
fn a_sender_cannot_tie_an_evm_wallet_to_its_own_identity() {
    let env = setup();
    let sender = evm_address_of(0x5E4D);
    sync(env, sender, 1);
    bridge_in(env, sender, evm_holder(), 0xBEEF, 2);
    let own: felt252 = evm_holder().into();
    assert(env.registry.identity_of(evm_holder()) == own, 'bound to the sender');
    assert(env.gateway.pending_of(evm_holder()) == AMOUNT.into(), 'not held');
}

// A gift names a note the wallet has not claimed: it is held, and released only
// into a note the wallet itself claimed (here by signature).
#[test]
fn a_held_amount_goes_only_into_a_note_the_wallet_signed_for() {
    let env = setup();
    sync(env, evm_holder(), 1);
    let sender = evm_address_of(0x5E4D);
    sync(env, sender, 2);
    register(env.pool, evm_holder(), KEY);
    let note = create_open_note(env.pool, evm_holder(), KEY, env.token.contract_address);
    bridge_in(env, sender, evm_holder(), note, 3);
    assert(env.gateway.pending_of(evm_holder()) == AMOUNT.into(), 'not held');

    let sig = evm_personal_sign(EVM_HOLDER_SECRET, env.gateway.note_claim_hash(note));
    env.gateway.register_note_evm(note, evm_holder(), sig);
    env.gateway.claim_to_note(evm_holder(), note, 0.try_into().unwrap());
    assert(note_value(env, note) == TWO_POW_128 + AMOUNT.into(), 'not released');
}

#[test]
#[should_panic(expected: 'INVALID_SIGNATURE')]
fn another_key_cannot_claim_a_note_for_an_evm_wallet() {
    let env = setup();
    let sig = evm_personal_sign(0xBAD, env.gateway.note_claim_hash(0xBEEF));
    env.gateway.register_note_evm(0xBEEF, evm_holder(), sig);
}

#[test]
#[should_panic(expected: 'NOT_AN_EVM_WALLET')]
fn a_starknet_account_claims_with_register_note() {
    let env = setup();
    let sig = evm_personal_sign(EVM_HOLDER_SECRET, env.gateway.note_claim_hash(0xBEEF));
    env.gateway.register_note_evm(0xBEEF, env.pool.contract_address, sig);
}

// ── Out ─────────────────────────────────────────────────────────────────────

#[test]
fn an_evm_wallet_bridges_back_through_a_proven_invoke() {
    let (env, _) = funded();
    let token = env.token.contract_address;
    let supply_before = IERC20Dispatcher { contract_address: token }.total_supply();
    let fees_before = balance(env.native, env.gateway.contract_address);

    let out: u128 = 600;
    let msg = exit(env, out, FEE);

    assert(env.endpoint.last_message() == encode_unlock(EVM_RECIPIENT, out.into()), 'unlock');
    assert(env.endpoint.last_dst_eid() == EVM_EID, 'to the lockbox chain');
    assert(env.endpoint.last_refund_address() == env.gateway.contract_address, 'refund');
    assert(
        IERC20Dispatcher { contract_address: token }.total_supply() == supply_before - out.into(),
        'burned',
    );
    assert(note_value(env, msg.open_note_id) == TWO_POW_128 + 1, 'change in the open note');
    assert(balance(token, env.gateway.contract_address) == 0, 'left in the gateway');
    assert(balance(token, env.pool.contract_address) == (AMOUNT - out).into(), 'rest in pool');
    assert(balance(env.native, env.gateway.contract_address) <= fees_before, 'fee not from float');
    assert(env.endpoint.send_count() == 1, 'one LayerZero send');
}

#[test]
#[should_panic(expected: 'EXIT_FEE_ABOVE_MAX')]
fn the_exit_fee_is_capped_by_what_the_holder_signed() {
    let (env, _) = funded();
    exit(env, 600, FEE - 1);
}

#[test]
#[should_panic(expected: 'ONLY_POOL')]
fn only_a_trusted_pool_invokes_the_exit() {
    let env = setup();
    env.gateway.privacy_invoke(0xBEEF, 1, EVM_RECIPIENT, FEE, 200_000);
}

#[test]
#[should_panic(expected: 'BAD_RECIPIENT')]
fn the_exit_pays_only_an_evm_address() {
    let env = setup();
    start_cheat_caller_address(env.gateway.contract_address, env.pool.contract_address);
    env.gateway.privacy_invoke(0xBEEF, 1, TWO_POW_128 * 0x100000000, FEE, 200_000);
}

#[test]
#[should_panic(expected: 'TWIN_NOT_RECEIVED')]
fn the_exit_burns_only_what_the_pool_paid_it() {
    let env = setup();
    start_cheat_caller_address(env.gateway.contract_address, env.pool.contract_address);
    env.gateway.privacy_invoke(0xBEEF, 1, EVM_RECIPIENT, FEE, 200_000);
}

#[test]
fn the_owner_sweeps_the_fee_float() {
    let env = setup();
    let to: ContractAddress = 0x70.try_into().unwrap();
    start_cheat_caller_address(env.gateway.contract_address, owner());
    env.gateway.sweep_native(to, FEE);
    assert(balance(env.native, to) == FEE, 'not swept');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn only_the_owner_sweeps() {
    let env = setup();
    env.gateway.sweep_native(stranger(), FEE);
}
