// Bridging straight into a Veil pool note.
//
// A bridge-in normally mints to the recipient's wallet, which is a public
// balance. Addressed to an open note instead, it lands in the pool.
//
// The rule that governs everything here: by the time a message arrives the
// tokens are already escrowed on the source chain, so nothing may revert and
// nothing may be lost. The pool is called from inside `lz_receive`, which makes
// it the most dangerous thing the bridge touches, so the gateway mints into its
// own custody and lets the pool PULL. A pool that reverts, is paused, or has not
// allow-listed this gateway never receives anything, and the sweep hands the
// balance to the recipient.
//
// The other half is the note CLAIM. `fill_open_note` is one-shot and the pool
// cannot say who owns a note, while note ids are public. Without a claim any
// sender could name any note and burn it with dust.

use core::num::traits::Zero;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil_bridge::bridged_token::{
    IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait,
};
use veil_bridge::gateway::{IVeilBridgeGatewayDispatcher, IVeilBridgeGatewayDispatcherTrait};
use veil_bridge::lz::{
    Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, Origin,
};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};
use veil_bridge::mocks::{IMockPoolExtDispatcher, IMockPoolExtDispatcherTrait};
use veil_bridge::msg_codec::{
    DELIVERY_POOL, DELIVERY_WALLET, IdentitySnapshot, MintMessage, encode_mint,
};

const EVM_EID: u32 = 30101;
const NOTE: felt252 = 0xBEEF;
const OTHER_NOTE: felt252 = 0xF00D;

fn owner() -> ContractAddress { 1000.try_into().unwrap() }
fn alice() -> ContractAddress { 101.try_into().unwrap() }
fn mallory() -> ContractAddress { 666.try_into().unwrap() }
fn evm_alice() -> felt252 { 0xA11CE }
fn evm_mallory() -> felt252 { 0xBAD }
fn peer() -> Bytes32 { Bytes32 { value: 0xDEADBEEF } }
fn amt(n: u128) -> u256 { u256 { low: n, high: 0 } }

#[derive(Copy, Drop)]
struct Rig {
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    receiver: ILayerZeroReceiverDispatcher,
    pool: IMockPoolExtDispatcher,
    pool_addr: ContractAddress,
}

fn deploy(with_pool: bool) -> Rig {
    let native = declare("MockNativeToken").unwrap().contract_class();
    let (native_addr, _) = native.deploy(@array![]).unwrap();
    let endpoint = declare("MockLzEndpoint").unwrap().contract_class();
    let (endpoint_addr, _) = endpoint.deploy(@array![]).unwrap();

    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    let (registry_addr, _) = registry_class.deploy(@array![owner().into(), 0]).unwrap();

    let gateway_class = declare("VeilBridgeGateway").unwrap().contract_class();
    let (gateway_addr, _) = gateway_class
        .deploy(@array![
            owner().into(), endpoint_addr.into(), native_addr.into(), registry_addr.into(),
            EVM_EID.into(),
        ])
        .unwrap();

    let token_class = declare("VeilBridgedERC3643").unwrap().contract_class();
    let mut args: Array<felt252> = array![];
    let name: ByteArray = "Bridged Gold";
    let symbol: ByteArray = "bXAU";
    name.serialize(ref args);
    symbol.serialize(ref args);
    args.append(owner().into());
    args.append(registry_addr.into());
    args.append(0);
    let (token_addr, _) = token_class.deploy(@args).unwrap();

    let pool_class = declare("MockVeilPool").unwrap().contract_class();
    let (pool_addr, _) = pool_class.deploy(@array![]).unwrap();

    let registry = IVeilMirroredRegistryDispatcher { contract_address: registry_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };
    let gateway = IVeilBridgeGatewayDispatcher { contract_address: gateway_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway_addr);
    // The pool is a Starknet contract with no EVM identity, so it is registered
    // directly or it could never receive the twin.
    registry.set_local_identity(pool_addr, true, 840);
    stop_cheat_caller_address(registry_addr);

    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway_addr);
    stop_cheat_caller_address(token_addr);

    start_cheat_caller_address(gateway_addr, owner());
    gateway.set_token(token_addr);
    gateway.set_peer(EVM_EID, peer());
    if with_pool {
        gateway.set_pool(pool_addr);
    }
    stop_cheat_caller_address(gateway_addr);

    Rig {
        registry, token, gateway,
        receiver: ILayerZeroReceiverDispatcher { contract_address: gateway_addr },
        pool: IMockPoolExtDispatcher { contract_address: pool_addr },
        pool_addr,
    }
}

fn claim(r: Rig, who: ContractAddress, note_id: felt252) {
    start_cheat_caller_address(r.gateway.contract_address, who);
    r.gateway.register_note(note_id);
    stop_cheat_caller_address(r.gateway.contract_address);
}

fn deliver(r: Rig, message: ByteArray, nonce: u64) {
    start_cheat_caller_address(r.receiver.contract_address, r.gateway.get_endpoint());
    r
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce },
            Bytes32 { value: nonce.into() },
            message, alice(), Default::default(), 0,
        );
    stop_cheat_caller_address(r.receiver.contract_address);
}

fn mint_msg(
    evm: felt252, to: ContractAddress, amount: u256, seq: u64, verified: bool,
    delivery: u8, note_id: felt252,
) -> ByteArray {
    // Names no pool, so the gateway uses its default.
    mint_msg_to_pool(evm, to, amount, seq, verified, delivery, note_id, Zero::zero())
}

fn mint_msg_to_pool(
    evm: felt252, to: ContractAddress, amount: u256, seq: u64, verified: bool,
    delivery: u8, note_id: felt252, pool: ContractAddress,
) -> ByteArray {
    encode_mint(
        MintMessage {
            identity: IdentitySnapshot {
                evm_account: evm, seq, verified, frozen: false, country: 840,
            },
            sn_recipient: to, amount, delivery, note_id, pool,
        },
    )
}

// ── The happy path ───────────────────────────────────────────────────────────

#[test]
fn a_pool_transfer_lands_in_the_note_and_not_the_wallet() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // The point of the exercise: the recipient's public balance is untouched
    // because the position arrived inside the pool.
    assert(r.token.balance_of(alice()) == 0, 'LANDED_IN_WALLET');
    assert(r.pool.filled(NOTE) == 1000, 'NOTE_NOT_FILLED');
    assert(r.token.balance_of(r.pool_addr) == amt(1000), 'POOL_BALANCE');
    assert(r.token.total_supply() == amt(1000), 'SUPPLY');
}

#[test]
fn the_gateway_keeps_nothing_and_leaves_no_allowance() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
    assert(
        r.token.allowance(r.gateway.contract_address, r.pool_addr) == 0, 'ALLOWANCE_LEFT',
    );
}

// ── Every way the pool can fail ──────────────────────────────────────────────

#[test]
fn a_reverting_pool_degrades_to_the_wallet() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    r.pool.set_mode(1);
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // The escrow on the source chain is already spent, so the tokens must land
    // somewhere. They land with the recipient.
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
    assert(r.token.balance_of(r.pool_addr) == 0, 'POOL_GOT_PAID');
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
}

#[test]
fn a_pool_that_takes_nothing_still_pays_the_recipient() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    r.pool.set_mode(2); // returns cleanly, pulls nothing
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // The return is not trusted; the balance is. A push-first design would have
    // left the tokens with the pool here.
    assert(r.token.balance_of(alice()) == amt(1000), 'TRUSTED_THE_CALL');
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
}

#[test]
fn an_already_filled_note_degrades_to_the_wallet() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, mint_msg(evm_alice(), alice(), amt(600), 1, true, DELIVERY_POOL, NOTE), 1);
    assert(r.pool.filled(NOTE) == 600, 'FIRST_FILL');

    // The fill is one-shot upstream, so a second transfer to the same note must
    // not be lost when the pool refuses it.
    deliver(r, mint_msg(evm_alice(), alice(), amt(400), 2, true, DELIVERY_POOL, NOTE), 2);
    assert(r.token.balance_of(alice()) == amt(400), 'SECOND_NOT_SWEPT');
    assert(r.pool.filled(NOTE) == 600, 'NOTE_OVERWRITTEN');
}

#[test]
fn with_no_pool_configured_a_pool_transfer_lands_in_the_wallet() {
    let r = deploy(false);
    claim(r, alice(), NOTE);
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_DELIVERED');
}

#[test]
fn an_amount_too_large_for_a_note_lands_in_the_wallet() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    // `fill_open_note` takes a u128 and the note packs it into 128 bits, so this
    // cannot be represented. Refuse rather than truncate.
    let huge = u256 { low: 0, high: 1 };
    deliver(r, mint_msg(evm_alice(), alice(), huge, 1, true, DELIVERY_POOL, NOTE), 1);
    assert(r.token.balance_of(alice()) == huge, 'NOT_SWEPT');
    assert(r.pool.calls() == 0, 'POOL_CALLED');
}

// ── The note claim ───────────────────────────────────────────────────────────

#[test]
fn an_unclaimed_note_is_never_filled() {
    let r = deploy(true);
    // Nobody claimed it, so the gateway cannot know it is the recipient's.
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
    assert(r.pool.calls() == 0, 'POOL_CALLED');
}

#[test]
fn mallory_cannot_burn_a_note_she_does_not_own() {
    let r = deploy(true);
    claim(r, alice(), NOTE);

    // The attack the claim exists to stop: note ids are public and the fill is
    // one-shot, so naming someone else's note would strand its real proceeds.
    // Mallory addresses a dust transfer to herself but names Alice's note.
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1), 1, true, DELIVERY_POOL, NOTE), 1);
    assert(r.pool.filled(NOTE) == 0, 'ALICES_NOTE_BURNED');
    assert(r.pool.calls() == 0, 'POOL_CALLED');
    assert(r.token.balance_of(mallory()) == amt(1), 'MALLORY_NOT_SWEPT');

    // Alice's own transfer still fills it.
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 2, true, DELIVERY_POOL, NOTE), 2);
    assert(r.pool.filled(NOTE) == 1000, 'ALICE_BLOCKED');
}

#[test]
#[should_panic(expected: 'NOTE_ALREADY_CLAIMED')]
fn a_claimed_note_cannot_be_taken_over() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    // Otherwise a claim could be stolen after the fact.
    claim(r, mallory(), NOTE);
}

#[test]
fn claims_are_per_note() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    claim(r, mallory(), OTHER_NOTE);
    assert(r.gateway.note_owner(NOTE) == alice(), 'ALICE_CLAIM');
    assert(r.gateway.note_owner(OTHER_NOTE) == mallory(), 'MALLORY_CLAIM');
}

// ── Delivery never widens who may hold ───────────────────────────────────────

#[test]
fn pool_delivery_does_not_bypass_eligibility() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    // Asking for the pool must not be a way around the compliance gate.
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, false, DELIVERY_POOL, NOTE), 1);
    assert(r.gateway.pending_of(alice()) == amt(1000), 'NOT_QUARANTINED');
    assert(r.token.total_supply() == 0, 'SUPPLY_CREATED');
    assert(r.pool.calls() == 0, 'POOL_CALLED');
}

#[test]
fn a_wallet_transfer_is_unaffected_by_a_configured_pool() {
    let r = deploy(true);
    deliver(r, mint_msg(evm_alice(), alice(), amt(1000), 1, true, DELIVERY_WALLET, 0), 1);
    assert(r.token.balance_of(alice()) == amt(1000), 'WALLET_PATH_BROKEN');
    assert(r.pool.calls() == 0, 'POOL_CALLED');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_repoint_the_pool() {
    let r = deploy(true);
    start_cheat_caller_address(r.gateway.contract_address, mallory());
    r.gateway.set_pool(mallory());
}
