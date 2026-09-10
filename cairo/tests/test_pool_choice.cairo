// WHICH Veil pool a bridged asset lands in.
//
// A Veil pool is multi-asset: one pool carries any number of ERC-3643 tokens.
// So the asset does not imply the pool, and something has to choose. The
// default is the main Veil pool, the one already deployed and in use. An entity
// that runs its own pool wants that one instead, so the message may name it.
//
// Naming a pool means an address arrives over the wire and the gateway is asked
// to call it from inside `lz_receive`. It must not do that on a peer's say-so:
// `create_pool` is the only way a Veil pool exists, and it records the deployer,
// so the factory can tell a real pool from an address someone typed. That check
// is what keeps the choice permissionless -- a pool created a minute ago works,
// with nobody maintaining a list -- without letting a message point the gateway
// at a contract of its own choosing.
//
// As everywhere else in the bridge: a refused pool is a policy outcome, not an
// error. The tokens are already escrowed on the source chain by the time any of
// this runs, so they land in the recipient's wallet instead.

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
use veil_bridge::mocks::{
    IMockFactoryExtDispatcher, IMockFactoryExtDispatcherTrait, IMockPoolExtDispatcher,
    IMockPoolExtDispatcherTrait,
};
use veil_bridge::msg_codec::{
    DELIVERY_POOL, IdentitySnapshot, MintMessage, encode_mint,
};

const EVM_EID: u32 = 30101;
const NOTE: felt252 = 0xBEEF;
const NOTE_B: felt252 = 0xCAFE;

fn owner() -> ContractAddress { 1000.try_into().unwrap() }
fn alice() -> ContractAddress { 101.try_into().unwrap() }
fn entity() -> ContractAddress { 202.try_into().unwrap() }
fn evm_alice() -> felt252 { 0xA11CE }
fn peer() -> Bytes32 { Bytes32 { value: 0xDEADBEEF } }
fn amt(n: u128) -> u256 { u256 { low: n, high: 0 } }

#[derive(Copy, Drop)]
struct Rig {
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    receiver: ILayerZeroReceiverDispatcher,
    /// The main Veil pool: what a message that names none gets.
    main: IMockPoolExtDispatcher,
    main_addr: ContractAddress,
    /// An entity's own pool, deployed through the same factory.
    own: IMockPoolExtDispatcher,
    own_addr: ContractAddress,
    /// Not a pool at all -- a contract that would happily be called.
    impostor_addr: ContractAddress,
    factory: IMockFactoryExtDispatcher,
    factory_addr: ContractAddress,
}

fn deploy(wire_factory: bool) -> Rig {
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

    // Three plausible-looking pool addresses. Only two came from the factory.
    let pool_class = declare("MockVeilPool").unwrap().contract_class();
    let (main_addr, _) = pool_class.deploy(@array![]).unwrap();
    let (own_addr, _) = pool_class.deploy(@array![]).unwrap();
    let (impostor_addr, _) = pool_class.deploy(@array![]).unwrap();

    let factory_class = declare("MockVeilFactory").unwrap().contract_class();
    let (factory_addr, _) = factory_class.deploy(@array![]).unwrap();
    let factory = IMockFactoryExtDispatcher { contract_address: factory_addr };
    // `create_pool` recorded these two. It never saw the impostor.
    factory.register(main_addr, owner());
    factory.register(own_addr, entity());

    let registry = IVeilMirroredRegistryDispatcher { contract_address: registry_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };
    let gateway = IVeilBridgeGatewayDispatcher { contract_address: gateway_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway_addr);
    // Pools are Starknet contracts with no EVM identity. Registered directly or
    // they could never hold the twin. The impostor is registered too, so that
    // nothing here passes merely because it lacks an identity.
    registry.set_local_identity(main_addr, true, 840);
    registry.set_local_identity(own_addr, true, 840);
    registry.set_local_identity(impostor_addr, true, 840);
    stop_cheat_caller_address(registry_addr);

    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway_addr);
    stop_cheat_caller_address(token_addr);

    start_cheat_caller_address(gateway_addr, owner());
    gateway.set_token(token_addr);
    gateway.set_peer(EVM_EID, peer());
    gateway.set_pool(main_addr);
    if wire_factory {
        gateway.set_factory(factory_addr);
    }
    stop_cheat_caller_address(gateway_addr);

    Rig {
        registry, token, gateway,
        receiver: ILayerZeroReceiverDispatcher { contract_address: gateway_addr },
        main: IMockPoolExtDispatcher { contract_address: main_addr }, main_addr,
        own: IMockPoolExtDispatcher { contract_address: own_addr }, own_addr,
        impostor_addr,
        factory, factory_addr,
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

fn msg(
    to: ContractAddress, amount: u256, seq: u64, note_id: felt252, pool: ContractAddress,
) -> ByteArray {
    encode_mint(
        MintMessage {
            identity: IdentitySnapshot {
                evm_account: evm_alice(), seq, verified: true, frozen: false, country: 840,
            },
            sn_recipient: to, amount, delivery: DELIVERY_POOL, note_id, pool,
        },
    )
}

// ── Choosing a pool ──────────────────────────────────────────────────────────

#[test]
fn naming_no_pool_uses_the_main_one() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, Zero::zero()), 1);

    assert(r.main.filled(NOTE) == 1000, 'NOT_IN_MAIN');
    assert(r.own.filled(NOTE) == 0, 'LEAKED_TO_OWN');
    assert(r.token.balance_of(alice()) == 0, 'LANDED_IN_WALLET');
}

#[test]
fn naming_the_main_pool_explicitly_is_the_same_as_naming_none() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.main_addr), 1);

    assert(r.main.filled(NOTE) == 1000, 'NOT_IN_MAIN');
    assert(r.token.balance_of(alice()) == 0, 'LANDED_IN_WALLET');
}

#[test]
fn a_holder_can_send_to_an_entitys_own_pool() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.own_addr), 1);

    // The whole point: the asset went where the holder asked, not to the default.
    assert(r.own.filled(NOTE) == 1000, 'NOT_IN_OWN');
    assert(r.token.balance_of(r.own_addr) == amt(1000), 'OWN_BALANCE');
    assert(r.main.filled(NOTE) == 0, 'WENT_TO_MAIN');
    assert(r.token.balance_of(alice()) == 0, 'LANDED_IN_WALLET');
}

#[test]
fn one_pool_carries_more_than_one_asset() {
    // The property this whole design rests on. Two different ERC-3643 assets,
    // bridged separately, both end up inside the SAME pool -- which is why
    // "which pool" is a question at all, and why it is never answered by the
    // asset.
    let r = deploy(true);

    let second = declare("VeilBridgedERC3643").unwrap().contract_class();

    // A second registry and gateway, because each asset mirrors its own EVM
    // registry and each gateway escrows exactly one asset. Everything is
    // per-asset EXCEPT the pool, which both point at.
    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    let (registry2_addr, _) = registry_class.deploy(@array![owner().into(), 0]).unwrap();
    let registry2 = IVeilMirroredRegistryDispatcher { contract_address: registry2_addr };

    let mut args2: Array<felt252> = array![];
    let name2: ByteArray = "Bridged Silver";
    let symbol2: ByteArray = "bXAG";
    name2.serialize(ref args2);
    symbol2.serialize(ref args2);
    args2.append(owner().into());
    args2.append(registry2_addr.into());
    args2.append(0);
    let (silver_addr2, _) = second.deploy(@args2).unwrap();
    let silver = IVeilBridgedERC3643Dispatcher { contract_address: silver_addr2 };

    let gateway_class = declare("VeilBridgeGateway").unwrap().contract_class();
    let (gw2_addr, _) = gateway_class
        .deploy(@array![
            owner().into(), r.gateway.get_endpoint().into(),
            r.gateway.native_token().into(), registry2_addr.into(), EVM_EID.into(),
        ])
        .unwrap();
    let gw2 = IVeilBridgeGatewayDispatcher { contract_address: gw2_addr };

    start_cheat_caller_address(registry2_addr, owner());
    registry2.set_gateway(gw2_addr);
    registry2.set_local_identity(r.main_addr, true, 840);
    stop_cheat_caller_address(registry2_addr);
    start_cheat_caller_address(silver_addr2, owner());
    silver.set_gateway(gw2_addr);
    stop_cheat_caller_address(silver_addr2);
    start_cheat_caller_address(gw2_addr, owner());
    gw2.set_token(silver_addr2);
    gw2.set_peer(EVM_EID, peer());
    gw2.set_pool(r.main_addr);
    gw2.set_factory(r.factory_addr);
    stop_cheat_caller_address(gw2_addr);

    // Gold through the first gateway.
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.main_addr), 1);

    // Silver through the second, into the same pool.
    start_cheat_caller_address(gw2_addr, alice());
    gw2.register_note(NOTE_B);
    stop_cheat_caller_address(gw2_addr);
    start_cheat_caller_address(gw2_addr, gw2.get_endpoint());
    ILayerZeroReceiverDispatcher { contract_address: gw2_addr }
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce: 1 },
            Bytes32 { value: 1 },
            msg(alice(), amt(500), 1, NOTE_B, r.main_addr), alice(), Default::default(), 0,
        );
    stop_cheat_caller_address(gw2_addr);

    // One pool, two assets, two notes.
    assert(r.main.filled(NOTE) == 1000, 'GOLD_NOTE');
    assert(r.main.filled(NOTE_B) == 500, 'SILVER_NOTE');
    assert(r.token.balance_of(r.main_addr) == amt(1000), 'GOLD_BALANCE');
    assert(silver.balance_of(r.main_addr) == amt(500), 'SILVER_BALANCE');
}

// ── Refusing a pool ──────────────────────────────────────────────────────────

#[test]
fn a_pool_the_factory_never_made_is_refused() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.impostor_addr), 1);

    // The gateway never called it, so it holds nothing and its note is empty.
    assert(r.token.balance_of(r.impostor_addr) == 0, 'IMPOSTOR_PAID');
    assert(
        IMockPoolExtDispatcher { contract_address: r.impostor_addr }.calls() == 0,
        'IMPOSTOR_CALLED',
    );
    // And nothing was lost: the escrow is already spent, so it lands in the wallet.
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
    assert(r.token.balance_of(r.gateway.contract_address) == 0, 'GATEWAY_RETAINED');
    assert(r.main.filled(NOTE) == 0, 'SILENTLY_REROUTED');
}

#[test]
fn with_no_factory_wired_only_the_main_pool_is_reachable() {
    let r = deploy(false);
    claim(r, alice(), NOTE);

    // Nothing can vouch for an alternative, so it is declined rather than
    // called on trust.
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.own_addr), 1);
    assert(r.own.filled(NOTE) == 0, 'CALLED_UNVOUCHED');
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');

    // The default still works without a factory: the operator set it.
    claim(r, alice(), NOTE_B);
    deliver(r, msg(alice(), amt(500), 2, NOTE_B, Zero::zero()), 2);
    assert(r.main.filled(NOTE_B) == 500, 'DEFAULT_BROKEN');
}

#[test]
fn a_broken_factory_does_not_take_the_message_down() {
    let r = deploy(true);
    claim(r, alice(), NOTE);
    r.factory.set_broken(true);

    // The question cannot be answered, so the answer is no -- but `lz_receive`
    // still completes and the tokens still reach the recipient.
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.own_addr), 1);
    assert(r.own.filled(NOTE) == 0, 'CALLED_ANYWAY');
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
    assert(r.token.total_supply() == amt(1000), 'SUPPLY');
}

#[test]
fn a_refused_pool_never_double_mints() {
    // The fallback mints to the wallet. If the refusal happened after a mint
    // rather than before, the amount would exist twice.
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.impostor_addr), 1);

    assert(r.token.total_supply() == amt(1000), 'SUPPLY_INFLATED');
}

// ── Attacks ──────────────────────────────────────────────────────────────────

#[test]
fn mallory_cannot_redirect_a_transfer_into_a_contract_she_controls() {
    // Mallory forges the pool field on a message addressed to alice, pointing at
    // a contract of her own that would take the tokens on arrival. The factory
    // never deployed it, so the gateway declines to call it and alice keeps her
    // asset.
    let r = deploy(true);
    claim(r, alice(), NOTE);
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.impostor_addr), 1);

    assert(r.token.balance_of(r.impostor_addr) == 0, 'MALLORY_PAID');
    assert(r.token.balance_of(alice()) == amt(1000), 'ALICE_ROBBED');
}

#[test]
fn a_registered_pool_still_cannot_take_an_unclaimed_note() {
    // Being a real pool is not authority over a note. The claim still governs.
    let r = deploy(true);
    // alice never claimed NOTE.
    deliver(r, msg(alice(), amt(1000), 1, NOTE, r.own_addr), 1);

    assert(r.own.filled(NOTE) == 0, 'FILLED_UNCLAIMED');
    assert(r.token.balance_of(alice()) == amt(1000), 'NOT_SWEPT');
}

#[test]
fn pool_choice_does_not_bypass_eligibility() {
    // An unverified sender is quarantined whichever pool they name.
    let r = deploy(true);
    claim(r, alice(), NOTE);
    let message = encode_mint(
        MintMessage {
            identity: IdentitySnapshot {
                evm_account: evm_alice(), seq: 1, verified: false, frozen: false, country: 840,
            },
            sn_recipient: alice(), amount: amt(1000), delivery: DELIVERY_POOL,
            note_id: NOTE, pool: r.own_addr,
        },
    );
    deliver(r, message, 1);

    assert(r.own.filled(NOTE) == 0, 'FILLED_UNVERIFIED');
    assert(r.token.balance_of(alice()) == 0, 'MINTED_UNVERIFIED');
    assert(r.gateway.pending_of(alice()) == amt(1000), 'NOT_QUARANTINED');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_repoint_the_factory() {
    let r = deploy(true);
    start_cheat_caller_address(r.gateway.contract_address, alice());
    r.gateway.set_factory(alice());
}
