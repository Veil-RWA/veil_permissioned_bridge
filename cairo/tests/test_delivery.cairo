// Pool delivery: what happens when a bridge-in is routed into a Veil pool note
// instead of a public wallet, and -- mostly -- what happens when that fails.
//
// The rule the gateway must never break is the same one that governs every
// inbound path: the tokens are already escrowed on the source chain by the time
// a message arrives, so nothing here may revert and nothing may be lost. An
// adapter is third-party code called from inside `lz_receive`, which makes it
// the most dangerous thing the bridge touches. So the interesting tests are not
// the happy path; they are the four ways an adapter can misbehave, each of
// which must end with the recipient holding their tokens.
//
// The design that makes that possible is PULL, not push: the gateway mints into
// its own custody and approves the adapter for exactly one transfer. An adapter
// that reverts, declines, or lies about succeeding never receives anything, and
// the sweep hands the balance to the recipient.

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
use veil_bridge::mocks::{IMockAdapterExtDispatcher, IMockAdapterExtDispatcherTrait};
use veil_bridge::msg_codec::{
    DELIVERY_POOL, DELIVERY_WALLET, IdentitySnapshot, MintMessage, encode_mint,
};

const EVM_EID: u32 = 30101;
const NOTE: felt252 = 0xBEEF;

fn owner() -> ContractAddress { 1000.try_into().unwrap() }
fn alice() -> ContractAddress { 101.try_into().unwrap() }
fn evm_alice() -> felt252 { 0xA11CE }
fn evm_adapter() -> felt252 { 0xADA9 }
fn peer() -> Bytes32 { Bytes32 { value: 0xDEADBEEF } }
fn amt(n: u128) -> u256 { u256 { low: n, high: 0 } }

#[derive(Copy, Drop)]
struct Rig {
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    receiver: ILayerZeroReceiverDispatcher,
    adapter: IMockAdapterExtDispatcher,
    adapter_addr: ContractAddress,
}

/// `with_adapter` selects whether the gateway has anywhere to deliver to, so a
/// test can cover the unconfigured case.
fn deploy(with_adapter: bool) -> Rig {
    let native_class = declare("MockNativeToken").unwrap().contract_class();
    let (native_addr, _) = native_class.deploy(@array![]).unwrap();
    let endpoint_class = declare("MockLzEndpoint").unwrap().contract_class();
    let (endpoint, _) = endpoint_class.deploy(@array![]).unwrap();

    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    let (registry_addr, _) = registry_class.deploy(@array![owner().into(), 0]).unwrap();

    let gateway_class = declare("VeilBridgeGateway").unwrap().contract_class();
    let (gateway_addr, _) = gateway_class
        .deploy(
            @array![
                owner().into(), endpoint.into(), native_addr.into(), registry_addr.into(),
                EVM_EID.into(),
            ],
        )
        .unwrap();

    let token_class = declare("VeilBridgedERC3643").unwrap().contract_class();
    let mut args: Array<felt252> = array![];
    let name: ByteArray = "Bridged Gold";
    let symbol: ByteArray = "bXAU";
    name.serialize(ref args);
    symbol.serialize(ref args);
    args.append(owner().into());
    args.append(registry_addr.into());
    args.append(0); // no local compliance module; rules are covered elsewhere
    let (token_addr, _) = token_class.deploy(@args).unwrap();

    let adapter_class = declare("MockPoolAdapter").unwrap().contract_class();
    let (adapter_addr, _) = adapter_class.deploy(@array![]).unwrap();

    let registry = IVeilMirroredRegistryDispatcher { contract_address: registry_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };
    let gateway = IVeilBridgeGatewayDispatcher { contract_address: gateway_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway_addr);
    stop_cheat_caller_address(registry_addr);
    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway_addr);
    stop_cheat_caller_address(token_addr);
    start_cheat_caller_address(gateway_addr, owner());
    gateway.set_token(token_addr);
    gateway.set_peer(EVM_EID, peer());
    if with_adapter {
        gateway.set_delivery_adapter(adapter_addr);
    }
    stop_cheat_caller_address(gateway_addr);

    // The adapter has to be an eligible holder to receive the twin, exactly as
    // a Veil pool must be a registered identity.
    start_cheat_caller_address(registry_addr, gateway_addr);
    registry.apply_identity(evm_adapter(), 1, true, false, 840);
    registry.bind(adapter_addr, evm_adapter());
    stop_cheat_caller_address(registry_addr);

    Rig {
        registry,
        token,
        gateway,
        receiver: ILayerZeroReceiverDispatcher { contract_address: gateway_addr },
        adapter: IMockAdapterExtDispatcher { contract_address: adapter_addr },
        adapter_addr,
    }
}

fn deliver(r: Rig, message: ByteArray, nonce: u64) {
    start_cheat_caller_address(r.receiver.contract_address, r.gateway.get_endpoint());
    r
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce },
            Bytes32 { value: nonce.into() },
            message,
            alice(),
            Default::default(),
            0,
        );
    stop_cheat_caller_address(r.receiver.contract_address);
}

fn mint_msg(amount: u256, seq: u64, verified: bool, delivery: u8, note_id: felt252) -> ByteArray {
    encode_mint(
        MintMessage {
            identity: IdentitySnapshot {
                evm_account: evm_alice(), seq, verified, frozen: false, country: 840,
            },
            sn_recipient: alice(),
            amount,
            delivery,
            note_id,
        },
    )
}

// ── The happy path ───────────────────────────────────────────────────────────

#[test]
fn a_pool_transfer_lands_in_the_note_and_not_the_wallet() {
    let r = deploy(true);
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // The point of the whole exercise: the recipient's public balance is
    // untouched, because the position arrived inside the pool.
    assert(r.token.balance_of(alice()) == 0, 'LANDED_IN_WALLET');
    assert(r.adapter.pulled() == amt(1000), 'ADAPTER_DID_NOT_PULL');
    assert(r.token.balance_of(r.adapter_addr) == amt(1000), 'ADAPTER_BALANCE');
    assert(r.adapter.last_recipient() == alice(), 'RECIPIENT_NOT_PASSED');
    assert(r.adapter.last_note() == NOTE, 'NOTE_NOT_PASSED');
    // Supply is still one-for-one with the escrow.
    assert(r.token.total_supply() == amt(1000), 'SUPPLY');
}

#[test]
fn the_gateway_keeps_nothing_and_leaves_no_allowance() {
    let r = deploy(true);
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // A standing allowance would let the adapter help itself to a later
    // transfer that happens to pass through custody.
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
    assert(
        r.token.allowance(r.gateway.contract_address, r.adapter_addr) == 0, 'ALLOWANCE_LEFT',
    );
}

// ── Every way an adapter can fail ────────────────────────────────────────────

#[test]
fn a_reverting_adapter_degrades_to_the_wallet() {
    let r = deploy(true);
    r.adapter.set_mode(2); // panics inside deliver
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // The message must not be taken down with it: the escrow on the source
    // chain is already spent, so the tokens have to end up somewhere.
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
    assert(r.token.balance_of(r.adapter_addr) == 0, 'ADAPTER_GOT_PAID');
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
    assert(r.gateway.pending_of(alice()) == 0, 'UNEXPECTED_QUARANTINE');
}

#[test]
fn a_declining_adapter_degrades_to_the_wallet() {
    let r = deploy(true);
    r.adapter.set_mode(1); // returns false without pulling
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
    assert(r.adapter.calls() == 1, 'ADAPTER_NOT_CALLED');
    assert(r.token.balance_of(r.adapter_addr) == 0, 'ADAPTER_GOT_PAID');
}

#[test]
fn an_adapter_that_claims_success_without_pulling_still_pays_the_recipient() {
    let r = deploy(true);
    r.adapter.set_mode(3); // returns true, takes nothing
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);

    // The return value is not trusted; the balance is. This is the case a
    // push-first design would get wrong, and the reason for the sweep.
    assert(r.token.balance_of(alice()) == amt(1000), 'TRUSTED_THE_RETURN_VALUE');
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
}

#[test]
fn with_no_adapter_configured_a_pool_transfer_lands_in_the_wallet() {
    let r = deploy(false);
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, NOTE), 1);
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_DELIVERED');
}

#[test]
fn a_pool_transfer_with_no_note_id_lands_in_the_wallet() {
    let r = deploy(true);
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_POOL, 0), 1);
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_DELIVERED');
    assert(r.adapter.calls() == 0, 'ADAPTER_CALLED_WITH_NO_NOTE');
}

// ── Delivery never widens who may hold ───────────────────────────────────────

#[test]
fn pool_delivery_does_not_bypass_eligibility() {
    let r = deploy(true);
    // Asking for the pool must not be a way around the compliance gate: an
    // ineligible recipient quarantines exactly as they would for a wallet
    // transfer, and the adapter is never called.
    deliver(r, mint_msg(amt(1000), 1, false, DELIVERY_POOL, NOTE), 1);

    assert(r.gateway.pending_of(alice()) == amt(1000), 'NOT_QUARANTINED');
    assert(r.token.total_supply() == 0, 'SUPPLY_CREATED');
    assert(r.adapter.calls() == 0, 'ADAPTER_CALLED');
}

#[test]
fn a_wallet_transfer_is_unaffected_by_a_configured_adapter() {
    let r = deploy(true);
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_WALLET, 0), 1);
    assert(r.token.balance_of(alice()) == amt(1000), 'WALLET_PATH_BROKEN');
    assert(r.adapter.calls() == 0, 'ADAPTER_CALLED');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn only_the_owner_may_set_the_delivery_adapter() {
    let r = deploy(true);
    // Owning the adapter would mean redirecting every pool-bound transfer.
    start_cheat_caller_address(r.gateway.contract_address, alice());
    r.gateway.set_delivery_adapter(alice());
}

#[test]
fn the_gateway_cannot_be_used_as_a_holder_by_anyone_else() {
    let r = deploy(true);
    deliver(r, mint_msg(amt(1000), 1, true, DELIVERY_WALLET, 0), 1);

    // The twin treats the gateway as an eligible holder so it can take custody
    // mid-delivery. That must not become a way for a user to park tokens there,
    // so a transfer in is refused: the exemption covers the gateway SENDING,
    // and minting to it, not receiving from the public.
    assert(r.registry.identity_of(r.gateway.contract_address) == 0, 'GATEWAY_BOUND');
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_HOLDS');
}
