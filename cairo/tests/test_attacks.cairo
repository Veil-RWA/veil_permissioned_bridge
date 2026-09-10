// Attack tests: what an adversary can and cannot do to the bridge.
//
// Every test here is an attempt to steal, inflate, or hijack. Successes appear
// only where they are needed to set up an attack or to prove one was blocked
// for the right reason.
//
// The threat model, stated so the gaps are visible rather than implied:
//
//   ASSUMED HONEST -- the owner (who wires contracts and applies rule specs),
//   the issuer's agents, the configured LayerZero peer, and the DVN set backing
//   the pathway. A compromised peer can mint arbitrary twin supply; that is
//   inherent to any bridge and is why the DVN configuration is part of the
//   security argument, not an afterthought.
//
//   ASSUMED HOSTILE -- everyone else: any caller, any token holder, any party
//   who can get a message delivered, and any holder whose eligibility was
//   revoked on the source chain.
//
// The invariant these defend: twin supply plus quarantined balance never
// exceeds what is escrowed on the source chain, and no address ever holds or
// moves twin tokens without a live, fresh, un-revoked eligibility record.

use core::num::traits::Zero;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil_bridge::bridged_token::{
    IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait,
};
use veil_bridge::compliance::rules::{
    IMirroredComplianceDispatcher, IMirroredComplianceDispatcherTrait,
};
use veil_bridge::gateway::{IVeilBridgeGatewayDispatcher, IVeilBridgeGatewayDispatcherTrait};
use veil_bridge::lz::{
    Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, MessagingFee, Origin,
};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};
use veil_bridge::msg_codec::{
    DELIVERY_WALLET,IdentitySnapshot, MintMessage, encode_identity, encode_mint};

const EVM_EID: u32 = 30101;
const STALENESS: u64 = 3600;

fn owner() -> ContractAddress {
    1000.try_into().unwrap()
}
fn victim() -> ContractAddress {
    101.try_into().unwrap()
}
fn bob() -> ContractAddress {
    202.try_into().unwrap()
}
/// The adversary. Never an owner, never an agent, never the endpoint.
fn mallory() -> ContractAddress {
    666.try_into().unwrap()
}

fn evm_victim() -> felt252 {
    0xFACE
}
fn evm_mallory() -> felt252 {
    0xBAD
}
fn evm_bob() -> felt252 {
    0xB0B
}

fn peer() -> Bytes32 {
    Bytes32 { value: 0xDEADBEEF }
}
fn amt(n: u128) -> u256 {
    u256 { low: n, high: 0 }
}

#[derive(Copy, Drop)]
struct Rig {
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    receiver: ILayerZeroReceiverDispatcher,
    compliance: IMirroredComplianceDispatcher,
}

fn deploy() -> Rig {
    let native_class = declare("MockNativeToken").unwrap().contract_class();
    let (native_addr, _) = native_class.deploy(@array![]).unwrap();
    let endpoint_class = declare("MockLzEndpoint").unwrap().contract_class();
    let (endpoint_mock, _) = endpoint_class.deploy(@array![]).unwrap();

    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    let (registry_addr, _) = registry_class
        .deploy(@array![owner().into(), STALENESS.into()])
        .unwrap();

    let gateway_class = declare("VeilBridgeGateway").unwrap().contract_class();
    let (gateway_addr, _) = gateway_class
        .deploy(
            @array![
                owner().into(),
                endpoint_mock.into(),
                native_addr.into(),
                registry_addr.into(),
                EVM_EID.into(),
            ],
        )
        .unwrap();

    let compliance_class = declare("MirroredCompliance").unwrap().contract_class();
    let (compliance_addr, _) = compliance_class
        .deploy(@array![owner().into(), registry_addr.into()])
        .unwrap();

    let token_class = declare("VeilBridgedERC3643").unwrap().contract_class();
    let mut args: Array<felt252> = array![];
    let name: ByteArray = "Bridged AAPL";
    let symbol: ByteArray = "bAAPL";
    name.serialize(ref args);
    symbol.serialize(ref args);
    args.append(owner().into());
    args.append(registry_addr.into());
    args.append(compliance_addr.into());
    let (token_addr, _) = token_class.deploy(@args).unwrap();

    let registry = IVeilMirroredRegistryDispatcher { contract_address: registry_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };
    let gateway = IVeilBridgeGatewayDispatcher { contract_address: gateway_addr };
    let compliance = IMirroredComplianceDispatcher { contract_address: compliance_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway_addr);
    stop_cheat_caller_address(registry_addr);
    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway_addr);
    token.set_compliance(compliance_addr);
    stop_cheat_caller_address(token_addr);
    start_cheat_caller_address(compliance_addr, owner());
    compliance.set_token(token_addr);
    stop_cheat_caller_address(compliance_addr);
    start_cheat_caller_address(gateway_addr, owner());
    gateway.set_token(token_addr);
    gateway.set_peer(EVM_EID, peer());
    stop_cheat_caller_address(gateway_addr);

    Rig {
        registry,
        token,
        gateway,
        receiver: ILayerZeroReceiverDispatcher { contract_address: gateway_addr },
        compliance,
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
            mallory(),
            Default::default(),
            0,
        );
    stop_cheat_caller_address(r.receiver.contract_address);
}

fn mint_msg(
    evm: felt252, to: ContractAddress, amount: u256, seq: u64, verified: bool,
) -> ByteArray {
    encode_mint(
        MintMessage {
            identity: IdentitySnapshot {
                evm_account: evm, seq, verified, frozen: false, country: 840,
            },
            sn_recipient: to,
            amount,
            delivery: DELIVERY_WALLET,
            note_id: 0,
            pool: Zero::zero(),
        },
    )
}

// ── Forging inbound messages ─────────────────────────────────────────────────

#[test]
#[should_panic(expected: 'ONLY_ENDPOINT')]
fn mallory_cannot_mint_by_calling_lz_receive_herself() {
    let r = deploy();
    // The most direct theft: hand the gateway a mint for yourself.
    start_cheat_caller_address(r.receiver.contract_address, mallory());
    r
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce: 1 },
            Bytes32 { value: 1 },
            mint_msg(evm_mallory(), mallory(), amt(1000000), 1, true),
            mallory(),
            Default::default(),
            0,
        );
}

#[test]
#[should_panic(expected: 'ONLY_PEER')]
fn mallory_cannot_mint_by_spoofing_the_source_contract() {
    let r = deploy();
    // Even with the real endpoint as caller, the sender must be the peer.
    start_cheat_caller_address(r.receiver.contract_address, r.gateway.get_endpoint());
    r
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: Bytes32 { value: 0xBAD }, nonce: 1 },
            Bytes32 { value: 1 },
            mint_msg(evm_mallory(), mallory(), amt(1000000), 1, true),
            mallory(),
            Default::default(),
            0,
        );
}

#[test]
#[should_panic(expected: 'NO_PEER')]
fn mallory_cannot_mint_from_a_chain_that_was_never_configured() {
    let r = deploy();
    start_cheat_caller_address(r.receiver.contract_address, r.gateway.get_endpoint());
    r
        .receiver
        .lz_receive(
            Origin { src_eid: 12345, sender: peer(), nonce: 1 },
            Bytes32 { value: 1 },
            mint_msg(evm_mallory(), mallory(), amt(1000000), 1, true),
            mallory(),
            Default::default(),
            0,
        );
}

// ── Minting and supply ───────────────────────────────────────────────────────

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn mallory_cannot_mint_directly_on_the_token() {
    let r = deploy();
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 1, verified: true, frozen: false, country: 840,
    }), 1);
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.bridge_mint(mallory(), amt(1000000));
}

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn mallory_cannot_burn_another_holders_tokens() {
    let r = deploy();
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, true), 1);
    // Destroying someone else's position is not theft, but it is an attack.
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.bridge_burn(victim(), amt(1000));
}

#[test]
fn mallory_cannot_inflate_supply_by_replaying_an_identity_message() {
    let r = deploy();
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, true), 1);
    let supply_before = r.token.total_supply();

    // Compliance messages carry no value, so replaying one -- even many times,
    // even with fresh sequence numbers -- can never create supply.
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_victim(), seq: 2, verified: true, frozen: false, country: 840,
    }), 2);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_victim(), seq: 3, verified: true, frozen: false, country: 840,
    }), 3);

    assert(r.token.total_supply() == supply_before, 'SUPPLY_INFLATED');
    assert(r.token.balance_of(victim()) == amt(1000), 'BALANCE_INFLATED');
}

// ── Quarantine ───────────────────────────────────────────────────────────────

#[test]
fn mallory_cannot_redirect_a_quarantined_balance_to_herself() {
    let r = deploy();
    // The victim's bridge-in lands while they are ineligible, so it is held.
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, false), 1);
    assert(r.gateway.pending_of(victim()) == amt(1000), 'NOT_HELD');

    // Their KYC completes. Mallory may pay the gas -- claiming is deliberately
    // permissionless -- but the tokens can only go where the message said.
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_victim(), seq: 2, verified: true, frozen: false, country: 840,
    }), 2);
    start_cheat_caller_address(r.gateway.contract_address, mallory());
    r.gateway.claim_pending(victim());
    stop_cheat_caller_address(r.gateway.contract_address);

    assert(r.token.balance_of(victim()) == amt(1000), 'VICTIM_NOT_PAID');
    assert(r.token.balance_of(mallory()) == 0, 'MALLORY_PAID');
}

#[test]
#[should_panic(expected: 'NOTHING_PENDING')]
fn a_quarantined_balance_cannot_be_claimed_twice() {
    let r = deploy();
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, false), 1);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_victim(), seq: 2, verified: true, frozen: false, country: 840,
    }), 2);
    r.gateway.claim_pending(victim());
    // Draining the same credit twice would break the escrow invariant.
    r.gateway.claim_pending(victim());
}

// ── Identity and eligibility ─────────────────────────────────────────────────

#[test]
fn mallory_cannot_launder_a_revoked_identity_through_a_fresh_one() {
    let r = deploy();
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(500), 1, true), 1);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 2, verified: false, frozen: false, country: 840,
    }), 2);
    assert(!r.registry.is_verified(mallory()), 'NOT_REVOKED');

    // Bridging in again from a clean EVM account must not re-point her wallet.
    deliver(r, mint_msg(evm_bob(), mallory(), amt(500), 3, true), 3);
    assert(r.registry.identity_of(mallory()) == evm_mallory(), 'REBOUND');
    assert(!r.registry.is_verified(mallory()), 'LAUNDERED');
    assert(r.gateway.pending_of(mallory()) == amt(500), 'NOT_QUARANTINED');
}

#[test]
fn a_revoked_holder_cannot_move_value_by_any_route() {
    let r = deploy();
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1000), 1, true), 1);
    deliver(r, mint_msg(evm_bob(), bob(), amt(10), 2, true), 2);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 3, verified: false, frozen: false, country: 840,
    }), 3);

    // Holding is allowed after revocation; moving is not. The exits are checked
    // one by one in the panicking tests below -- here we assert the balance is
    // still there, so the block is a freeze and not a confiscation.
    assert(r.token.balance_of(mallory()) == amt(1000), 'BALANCE_SEIZED');
    assert(!r.registry.is_verified(mallory()), 'STILL_VERIFIED');
}

#[test]
#[should_panic(expected: 'SENDER_NOT_VERIFIED')]
fn a_revoked_holder_cannot_transfer_out() {
    let r = deploy();
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1000), 1, true), 1);
    deliver(r, mint_msg(evm_bob(), bob(), amt(10), 2, true), 2);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 3, verified: false, frozen: false, country: 840,
    }), 3);
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.transfer(bob(), amt(1000));
}

#[test]
#[should_panic(expected: 'SENDER_NOT_VERIFIED')]
fn a_revoked_holder_cannot_bridge_out() {
    let r = deploy();
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1000), 1, true), 1);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 3, verified: false, frozen: false, country: 840,
    }), 3);
    start_cheat_caller_address(r.gateway.contract_address, mallory());
    r
        .gateway
        .bridge_back(
            amt(1000),
            evm_mallory(),
            MessagingFee { native_fee: 0, lz_token_fee: 0 },
            200000,
            mallory(),
        );
}

#[test]
#[should_panic(expected: 'RECIPIENT_NOT_VERIFIED')]
fn tokens_cannot_be_parked_on_an_unmirrored_wallet_to_dodge_revocation() {
    let r = deploy();
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, true), 1);
    // A wallet the mirror has never heard of cannot receive, so there is no
    // "move it somewhere the registry cannot see it" escape.
    start_cheat_caller_address(r.token.contract_address, victim());
    r.token.transfer(mallory(), amt(1000));
}

#[test]
fn a_stale_record_freezes_a_holder_even_with_no_revocation_delivered() {
    let r = deploy();
    start_cheat_block_timestamp_global(1000);
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1000), 1, true), 1);
    assert(r.registry.is_verified(mallory()), 'NOT_VERIFIED');

    // The attack this defends: get revoked on the source chain and rely on
    // nobody paying to push the message. Expiry closes it without anyone acting.
    start_cheat_block_timestamp_global(1000 + STALENESS + 1);
    assert(!r.registry.is_verified(mallory()), 'STALE_STILL_LIVE');
    assert(r.token.balance_of(mallory()) == amt(1000), 'BALANCE_SEIZED');
}

#[test]
fn a_stale_revocation_cannot_be_replayed_to_restore_eligibility() {
    let r = deploy();
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1000), 5, true), 1);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 9, verified: false, frozen: false, country: 840,
    }), 2);
    assert(!r.registry.is_verified(mallory()), 'NOT_REVOKED');

    // Replaying the older "verified" record must not undo the revocation. This
    // is the whole reason records carry a sequence number.
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1), 5, true), 3);
    assert(!r.registry.is_verified(mallory()), 'REVOCATION_UNDONE');
    assert(r.registry.record(evm_mallory()).seq == 9, 'SEQ_REGRESSED');
}

// ── Binding capture: a real griefing vector, bounded and recoverable ─────────

#[test]
fn binding_capture_is_griefing_only_and_the_owner_can_undo_it() {
    let r = deploy();
    // Mallory bridges dust to a wallet the victim has not used yet. Because she
    // is the one bridging, the message carries HER EVM identity, so the
    // victim's wallet binds to Mallory. This is a real, unpreventable
    // consequence of letting anyone bridge to any address -- the alternative
    // would break first-time bridging entirely.
    deliver(r, mint_msg(evm_mallory(), victim(), amt(1), 1, true), 1);
    assert(r.registry.identity_of(victim()) == evm_mallory(), 'NOT_CAPTURED');
    // The dust genuinely mints: the wallet was unbound, and Mallory's identity
    // is live, so it carries the transfer.
    assert(r.token.balance_of(victim()) == amt(1), 'DUST_NOT_MINTED');
    assert(r.token.balance_of(mallory()) == 0, 'MALLORY_GAINED');

    // The harm is real but bounded: when Mallory is revoked, the victim's
    // wallet freezes with her, because it now hangs off her identity.
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 2, verified: false, frozen: false, country: 840,
    }), 2);
    assert(!r.registry.is_verified(victim()), 'FREEZE_NOT_INHERITED');

    // And the victim's own bridge-in is quarantined rather than misdirected --
    // it is never credited to Mallory.
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 3, true), 3);
    assert(r.gateway.pending_of(victim()) == amt(1000), 'NOT_QUARANTINED');
    assert(r.token.balance_of(mallory()) == 0, 'MALLORY_GAINED_LATE');

    // Recovery is the T-REX agent power applied to the binding.
    start_cheat_caller_address(r.registry.contract_address, owner());
    r.registry.admin_rebind(victim(), evm_victim());
    stop_cheat_caller_address(r.registry.contract_address);
    r.gateway.claim_pending(victim());
    // 1000 released, plus the dust that was already there.
    assert(r.token.balance_of(victim()) == amt(1001), 'NOT_RECOVERED');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_rebind_a_wallet_to_an_identity_of_her_choosing() {
    let r = deploy();
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, true), 1);
    start_cheat_caller_address(r.registry.contract_address, mallory());
    r.registry.admin_rebind(victim(), evm_mallory());
}

// ── Privilege ────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_repoint_the_peer_to_a_contract_she_controls() {
    let r = deploy();
    // Owning the peer would mean minting arbitrary supply.
    start_cheat_caller_address(r.gateway.contract_address, mallory());
    r.gateway.set_peer(EVM_EID, Bytes32 { value: 0xBAD });
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_swap_the_token_for_one_she_controls() {
    let r = deploy();
    start_cheat_caller_address(r.gateway.contract_address, mallory());
    r.gateway.set_token(mallory());
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_point_the_token_at_a_registry_that_vouches_for_her() {
    let r = deploy();
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.set_identity_registry(mallory());
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_disable_compliance_on_the_token() {
    let r = deploy();
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.set_compliance(0.try_into().unwrap());
}

#[test]
#[should_panic(expected: 'ONLY_AGENT')]
fn mallory_cannot_claw_back_another_holders_tokens() {
    let r = deploy();
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, true), 1);
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(1), 2, true), 2);
    // forced_transfer is the issuer's recovery lever, not a public one.
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.forced_transfer(victim(), mallory(), amt(1000));
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_make_herself_an_agent() {
    let r = deploy();
    start_cheat_caller_address(r.token.contract_address, mallory());
    r.token.add_agent(mallory());
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_widen_the_staleness_window_to_keep_a_dead_record_alive() {
    let r = deploy();
    start_cheat_caller_address(r.registry.contract_address, mallory());
    r.registry.set_staleness_window(0);
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn mallory_cannot_install_a_permissive_compliance_rule() {
    let r = deploy();
    start_cheat_caller_address(r.compliance.contract_address, mallory());
    r.compliance.add_rule(mallory());
}

// ── Value conservation ───────────────────────────────────────────────────────

#[test]
fn no_sequence_of_attacks_breaks_the_escrow_invariant() {
    let r = deploy();
    // Legitimate escrow on the source chain totals 1500.
    deliver(r, mint_msg(evm_victim(), victim(), amt(1000), 1, true), 1);
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(500), 2, false), 2);

    // Mallory throws everything harmless-but-noisy at it.
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 3, verified: true, frozen: false, country: 840,
    }), 3);
    deliver(r, encode_identity(IdentitySnapshot {
        evm_account: evm_mallory(), seq: 1, verified: true, frozen: false, country: 840,
    }), 4);
    r.gateway.claim_pending(mallory());
    deliver(r, mint_msg(evm_mallory(), mallory(), amt(500), 2, true), 5);

    // Supply plus quarantine still equals exactly what was escrowed, plus the
    // one genuinely new 500 bridge-in at nonce 5.
    let total = r.token.total_supply() + r.gateway.total_pending();
    assert(total == amt(2000), 'INVARIANT_BROKEN');
}
