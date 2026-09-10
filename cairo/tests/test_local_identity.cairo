// Contracts holding the twin.
//
// Every mirrored record describes an investor with an EVM counterpart. A
// Starknet CONTRACT -- a Veil pool, an AMM, a lending market -- has none, so
// without a path of its own it could never satisfy `is_verified` and could
// never receive the twin. A permissioned asset that only moves between bridged
// EOAs is not usable in any protocol, which defeats the point of bridging it.
//
// So infrastructure is registered directly, as a T-REX agent registers a pool in
// an identity registry on its own chain. The tests that matter are the
// boundaries: it must not be subject to staleness (there is no source record to
// expire), it must still fall under a global pause and under the token's own
// freeze, and it must be owner-only.

use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil_bridge::bridged_token::{
    IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait,
};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};

const STALENESS: u64 = 3600;
const US: u16 = 840;

fn owner() -> ContractAddress { 1000.try_into().unwrap() }
fn gateway() -> ContractAddress { 2000.try_into().unwrap() }
fn alice() -> ContractAddress { 101.try_into().unwrap() }
fn mallory() -> ContractAddress { 666.try_into().unwrap() }
/// Stands in for a Veil pool: a contract, with no EVM counterpart.
fn pool() -> ContractAddress { 7777.try_into().unwrap() }
fn evm_alice() -> felt252 { 0xA11CE }
fn amt(n: u128) -> u256 { u256 { low: n, high: 0 } }

#[derive(Copy, Drop)]
struct Rig {
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
}

fn deploy() -> Rig {
    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    let (registry_addr, _) = registry_class
        .deploy(@array![owner().into(), STALENESS.into()])
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

    let registry = IVeilMirroredRegistryDispatcher { contract_address: registry_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway());
    stop_cheat_caller_address(registry_addr);
    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway());
    stop_cheat_caller_address(token_addr);

    // An ordinary bridged investor, mirrored the normal way.
    start_cheat_caller_address(registry_addr, gateway());
    registry.apply_identity(evm_alice(), 1, true, false, US);
    registry.bind(alice(), evm_alice());
    stop_cheat_caller_address(registry_addr);
    start_cheat_caller_address(token_addr, gateway());
    token.bridge_mint(alice(), amt(1000));
    stop_cheat_caller_address(token_addr);

    Rig { registry, token }
}

fn register_pool(r: Rig, allowed: bool) {
    start_cheat_caller_address(r.registry.contract_address, owner());
    r.registry.set_local_identity(pool(), allowed, US);
    stop_cheat_caller_address(r.registry.contract_address);
}

// ── The gap this closes ──────────────────────────────────────────────────────

#[test]
#[should_panic(expected: 'RECIPIENT_NOT_VERIFIED')]
fn an_unregistered_contract_cannot_receive_the_twin() {
    let r = deploy();
    // The whole problem: a pool has no EVM identity, so the binding can never
    // vouch for it and the asset is unusable in any protocol.
    start_cheat_caller_address(r.token.contract_address, alice());
    r.token.transfer(pool(), amt(100));
}

#[test]
fn a_registered_contract_can_receive_and_send_the_twin() {
    let r = deploy();
    register_pool(r, true);
    assert(r.registry.is_verified(pool()), 'POOL_NOT_ELIGIBLE');

    start_cheat_caller_address(r.token.contract_address, alice());
    r.token.transfer(pool(), amt(400));
    stop_cheat_caller_address(r.token.contract_address);
    assert(r.token.balance_of(pool()) == amt(400), 'DEPOSIT_FAILED');

    // And back out again -- a pool that can take a deposit must be able to
    // return it.
    start_cheat_caller_address(r.token.contract_address, pool());
    r.token.transfer(alice(), amt(400));
    stop_cheat_caller_address(r.token.contract_address);
    assert(r.token.balance_of(alice()) == amt(1000), 'WITHDRAW_FAILED');
}

#[test]
fn a_registered_contract_does_not_expire() {
    let r = deploy();
    register_pool(r, true);
    start_cheat_block_timestamp_global(1);
    assert(r.registry.is_verified(pool()), 'NOT_ELIGIBLE');

    // Alice's mirrored record goes stale and she freezes, as designed. The pool
    // has no source record, so there is nothing to expire -- borrowing her
    // binding instead would have broken here, silently, much later.
    start_cheat_block_timestamp_global(1 + STALENESS + 1);
    assert(!r.registry.is_verified(alice()), 'INVESTOR_SHOULD_EXPIRE');
    assert(r.registry.is_verified(pool()), 'POOL_EXPIRED');
}

#[test]
fn revoking_a_contract_stops_it_receiving() {
    let r = deploy();
    register_pool(r, true);
    assert(r.registry.is_verified(pool()), 'NOT_ELIGIBLE');
    register_pool(r, false);
    assert(!r.registry.is_verified(pool()), 'STILL_ELIGIBLE');
}

// ── It must not become a hole ────────────────────────────────────────────────

#[test]
fn a_global_pause_still_stops_a_registered_contract() {
    let r = deploy();
    register_pool(r, true);
    start_cheat_caller_address(r.registry.contract_address, gateway());
    r.registry.apply_global(1, true);
    stop_cheat_caller_address(r.registry.contract_address);
    // Infrastructure is not above the issuer's pause.
    assert(!r.registry.is_verified(pool()), 'PAUSE_BYPASSED');
}

#[test]
#[should_panic(expected: 'RECIPIENT_FROZEN')]
fn the_token_freeze_still_applies_to_a_registered_contract() {
    let r = deploy();
    register_pool(r, true);
    start_cheat_caller_address(r.token.contract_address, owner());
    r.token.set_address_frozen(pool(), true);
    stop_cheat_caller_address(r.token.contract_address);

    start_cheat_caller_address(r.token.contract_address, alice());
    r.token.transfer(pool(), amt(100));
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_register_herself_as_infrastructure() {
    let r = deploy();
    // Otherwise this is a self-service bypass of the entire mirror.
    start_cheat_caller_address(r.registry.contract_address, mallory());
    r.registry.set_local_identity(mallory(), true, US);
}

#[test]
fn registering_a_contract_does_not_touch_the_mirrored_path() {
    let r = deploy();
    register_pool(r, true);
    // A local registration is not a binding: it must not appear as an identity,
    // or a revocation of that identity would silently un-register the pool.
    assert(r.registry.identity_of(pool()) == 0, 'LEAKED_INTO_BINDINGS');
    assert(r.registry.investor_country(pool()) == US, 'COUNTRY_NOT_SET');
    // And the investor path is unaffected.
    assert(r.registry.is_verified(alice()), 'INVESTOR_BROKEN');
    assert(r.registry.identity_of(alice()) == evm_alice(), 'BINDING_BROKEN');
}
