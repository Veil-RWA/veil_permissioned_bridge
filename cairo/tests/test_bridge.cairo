// Adversarial tests for the LayerZero ERC-3643 bridge.
//
// Scope: what the Starknet half enforces on its own, with the source chain
// simulated by handing the gateway the exact bytes the Solidity lockbox would
// have sent. That split is deliberate -- the gateway's job is to be safe
// against ANY message its peer could produce, including ones reflecting a
// revocation it has not seen yet, so the tests drive it directly rather than
// through a happy-path harness.
//
// The byte-layout tests are the contract between the two chains: they pin the
// exact wire encoding, so a change to either codec that is not mirrored on the
// other side fails here instead of on a testnet.

use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil_bridge::bridged_token::{
    IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait,
};
use veil_bridge::gateway::{IVeilBridgeGatewayDispatcher, IVeilBridgeGatewayDispatcherTrait};
use veil_bridge::lz::{
    Bytes32, ILayerZeroReceiverDispatcher, ILayerZeroReceiverDispatcherTrait, MessagingFee, Origin,
};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};
use veil_bridge::compliance::rules::{
    ComplianceSpec, IMirroredComplianceDispatcher, IMirroredComplianceDispatcherTrait,
};
use veil_bridge::msg_codec::{
    GlobalMessage, IdentitySnapshot, MintMessage, encode_global, encode_identity, encode_mint,
    encode_unlock,
};
use veil_bridge::mocks::{
    IMockEndpointExtDispatcher, IMockEndpointExtDispatcherTrait, IMockNativeTokenExtDispatcher,
    IMockNativeTokenExtDispatcherTrait,
};

// Ethereum mainnet / Starknet mainnet endpoint ids.
const EVM_EID: u32 = 30101;
const STALENESS: u64 = 3600;

fn owner() -> ContractAddress {
    1000.try_into().unwrap()
}
fn alice() -> ContractAddress {
    101.try_into().unwrap()
}
fn bob() -> ContractAddress {
    202.try_into().unwrap()
}
fn carol() -> ContractAddress {
    303.try_into().unwrap()
}
fn endpoint_addr() -> ContractAddress {
    9999.try_into().unwrap()
}
fn mallory() -> ContractAddress {
    666.try_into().unwrap()
}

/// EVM identities, as the 20-byte addresses the source registry keys on.
fn evm_alice() -> felt252 {
    0xA11CE
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

#[derive(Copy, Drop)]
struct Deployment {
    registry: IVeilMirroredRegistryDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
    gateway: IVeilBridgeGatewayDispatcher,
    receiver: ILayerZeroReceiverDispatcher,
    endpoint: IMockEndpointExtDispatcher,
    native: IMockNativeTokenExtDispatcher,
    native_addr: ContractAddress,
    compliance: IMirroredComplianceDispatcher,
}

/// Wires the full Starknet side against a mock endpoint. `real_endpoint`
/// selects whether the gateway points at the endpoint mock contract (needed to
/// exercise `bridge_back`) or at a bare address we impersonate for inbound
/// tests.
fn deploy(real_endpoint: bool) -> Deployment {
    let native_class = declare("MockNativeToken").unwrap().contract_class();
    let (native_addr, _) = native_class.deploy(@array![]).unwrap();

    let endpoint_class = declare("MockLzEndpoint").unwrap().contract_class();
    let (endpoint_mock_addr, _) = endpoint_class.deploy(@array![]).unwrap();

    let endpoint_for_gateway = if real_endpoint {
        endpoint_mock_addr
    } else {
        endpoint_addr()
    };

    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    let (registry_addr, _) = registry_class
        .deploy(@array![owner().into(), STALENESS.into()])
        .unwrap();

    let gateway_class = declare("VeilBridgeGateway").unwrap().contract_class();
    let (gateway_addr, _) = gateway_class
        .deploy(
            @array![
                owner().into(),
                endpoint_for_gateway.into(),
                native_addr.into(),
                registry_addr.into(),
                EVM_EID.into(),
            ],
        )
        .unwrap();

    let token_class = declare("VeilBridgedERC3643").unwrap().contract_class();
    let mut token_args: Array<felt252> = array![];
    let name: ByteArray = "Bridged AAPL";
    let symbol: ByteArray = "bAAPL";
    name.serialize(ref token_args);
    symbol.serialize(ref token_args);
    token_args.append(owner().into());
    token_args.append(registry_addr.into());
    token_args.append(0); // compliance wired below, once its address is known
    let (token_addr, _) = token_class.deploy(@token_args).unwrap();

    let compliance_class = declare("MirroredCompliance").unwrap().contract_class();
    let (compliance_addr, _) = compliance_class
        .deploy(@array![owner().into(), registry_addr.into()])
        .unwrap();

    let registry = IVeilMirroredRegistryDispatcher { contract_address: registry_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };
    let gateway = IVeilBridgeGatewayDispatcher { contract_address: gateway_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway_addr);
    stop_cheat_caller_address(registry_addr);

    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway_addr);
    token.set_compliance(compliance_addr);
    stop_cheat_caller_address(token_addr);

    let compliance = IMirroredComplianceDispatcher { contract_address: compliance_addr };
    start_cheat_caller_address(compliance_addr, owner());
    compliance.set_token(token_addr);
    stop_cheat_caller_address(compliance_addr);

    start_cheat_caller_address(gateway_addr, owner());
    gateway.set_token(token_addr);
    gateway.set_peer(EVM_EID, peer());
    stop_cheat_caller_address(gateway_addr);

    Deployment {
        registry,
        token,
        gateway,
        receiver: ILayerZeroReceiverDispatcher { contract_address: gateway_addr },
        endpoint: IMockEndpointExtDispatcher { contract_address: endpoint_mock_addr },
        native: IMockNativeTokenExtDispatcher { contract_address: native_addr },
        native_addr,
        compliance,
    }
}

/// Hand the gateway a message exactly as the endpoint would.
fn deliver(d: Deployment, message: ByteArray, nonce: u64) {
    let caller = d.gateway.get_endpoint();
    start_cheat_caller_address(d.receiver.contract_address, caller);
    d
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce },
            Bytes32 { value: nonce.into() },
            message,
            mallory(),
            Default::default(),
            0,
        );
    stop_cheat_caller_address(d.receiver.contract_address);
}

fn mint_msg(
    evm_account: felt252,
    recipient: ContractAddress,
    amount: u256,
    seq: u64,
    verified: bool,
    frozen: bool,
    country: u16,
) -> ByteArray {
    encode_mint(
        MintMessage {
            identity: IdentitySnapshot { evm_account, seq, verified, frozen, country },
            sn_recipient: recipient,
            amount,
        },
    )
}

fn identity_msg(
    evm_account: felt252, seq: u64, verified: bool, frozen: bool, country: u16,
) -> ByteArray {
    encode_identity(IdentitySnapshot { evm_account, seq, verified, frozen, country })
}

// ── Wire format ──────────────────────────────────────────────────────────────
// These pin the exact bytes. BridgeMsgCodec.sol must produce the same.

#[test]
fn mint_message_layout_is_pinned() {
    let message = mint_msg(evm_alice(), alice(), amt(1000), 7, true, false, 840);
    assert(message.len() == 109, 'MINT_LEN');
    assert(message.at(0).unwrap() == 1, 'KIND');
    // evm_alice = 0x0A11CE, right-aligned in the 32-byte word at offset 1,
    // so its three bytes land in the word's last three slots.
    assert(message.at(30).unwrap() == 0x0a, 'EVM_B0');
    assert(message.at(31).unwrap() == 0x11, 'EVM_B1');
    assert(message.at(32).unwrap() == 0xce, 'EVM_B2');
    // amount 1000 = 0x03e8, right-aligned in the word at offset 65.
    assert(message.at(95).unwrap() == 0x03, 'AMT_HI');
    assert(message.at(96).unwrap() == 0xe8, 'AMT_LO');
    // seq 7 as 8 big-endian bytes at 97.
    assert(message.at(104).unwrap() == 7, 'SEQ');
    assert(message.at(105).unwrap() == 1, 'VERIFIED');
    assert(message.at(106).unwrap() == 0, 'FROZEN');
    // country 840 = 0x0348.
    assert(message.at(107).unwrap() == 0x03, 'CTRY_HI');
    assert(message.at(108).unwrap() == 0x48, 'CTRY_LO');
}

#[test]
fn identity_and_global_layouts_are_pinned() {
    let identity = identity_msg(evm_bob(), 3, false, true, 76);
    assert(identity.len() == 45, 'ID_LEN');
    assert(identity.at(0).unwrap() == 2, 'ID_KIND');
    assert(identity.at(40).unwrap() == 3, 'ID_SEQ');
    assert(identity.at(41).unwrap() == 0, 'ID_VERIFIED');
    assert(identity.at(42).unwrap() == 1, 'ID_FROZEN');
    assert(identity.at(44).unwrap() == 76, 'ID_COUNTRY');

    // GLOBAL carries token STATE only. Rule parameters live in
    // MirroredCompliance, replicated at allowance time, not on the wire.
    let global = encode_global(GlobalMessage { seq: 2, paused: true });
    assert(global.len() == 10, 'GL_LEN');
    assert(global.at(0).unwrap() == 3, 'GL_KIND');
    assert(global.at(8).unwrap() == 2, 'GL_SEQ');
    assert(global.at(9).unwrap() == 1, 'GL_PAUSED');
}

#[test]
fn unlock_message_layout_is_pinned() {
    let message = encode_unlock(evm_bob(), amt(42));
    assert(message.len() == 65, 'UNLOCK_LEN');
    assert(message.at(0).unwrap() == 4, 'KIND');
    assert(message.at(31).unwrap() == 0x0b, 'RECIP');
    assert(message.at(64).unwrap() == 42, 'AMOUNT');
}

#[test]
#[should_panic(expected: 'BRIDGE_BAD_EVM_ADDR')]
fn unlock_rejects_an_oversized_evm_recipient() {
    // A felt that does not fit in 20 bytes is not an EVM address; packing it
    // would silently alias a different account on the far side.
    encode_unlock(0x1_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000, amt(1));
}

// ── Mirror semantics ─────────────────────────────────────────────────────────

#[test]
fn an_unbound_wallet_is_never_verified() {
    let d = deploy(false);
    assert(!d.registry.is_verified(alice()), 'UNBOUND_VERIFIED');
    assert(d.registry.investor_country(alice()) == 0, 'UNBOUND_COUNTRY');
}

#[test]
fn out_of_order_updates_are_dropped() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(100), 5, true, false, 840), 1);
    assert(d.registry.is_verified(alice()), 'SEQ5_NOT_APPLIED');

    // A revocation stamped BEFORE the record we hold must not take effect --
    // this is the whole reason records carry a sequence number.
    deliver(d, identity_msg(evm_alice(), 3, false, false, 840), 2);
    assert(d.registry.is_verified(alice()), 'STALE_REVOKE_APPLIED');
    assert(d.registry.record(evm_alice()).seq == 5, 'SEQ_REGRESSED');

    // A duplicate of the record we hold is also a no-op.
    deliver(d, identity_msg(evm_alice(), 5, false, false, 840), 3);
    assert(d.registry.is_verified(alice()), 'EQUAL_SEQ_APPLIED');

    // A genuinely newer revocation lands.
    deliver(d, identity_msg(evm_alice(), 6, false, false, 840), 4);
    assert(!d.registry.is_verified(alice()), 'NEW_REVOKE_IGNORED');
}

#[test]
fn eligibility_expires_when_the_mirror_goes_stale() {
    let d = deploy(false);
    start_cheat_block_timestamp_global(1000);
    deliver(d, mint_msg(evm_alice(), alice(), amt(100), 1, true, false, 840), 1);
    assert(d.registry.is_verified(alice()), 'FRESH_NOT_VERIFIED');

    // Inside the window: still good.
    start_cheat_block_timestamp_global(1000 + STALENESS);
    assert(d.registry.is_verified(alice()), 'EDGE_NOT_VERIFIED');

    // Past it: fail closed. Nothing pushed a revocation; the mirror simply
    // stops vouching for data it can no longer stand behind.
    start_cheat_block_timestamp_global(1000 + STALENESS + 1);
    assert(!d.registry.is_verified(alice()), 'STALE_STILL_VERIFIED');
    assert(!d.registry.is_fresh(evm_alice()), 'STALE_REPORTED_FRESH');

    // A refresh re-opens it without any change of opinion on the source side.
    deliver(d, identity_msg(evm_alice(), 2, true, false, 840), 2);
    assert(d.registry.is_verified(alice()), 'REFRESH_FAILED');
}

#[test]
fn revoking_one_evm_identity_revokes_every_wallet_bound_to_it() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(10), 1, true, false, 840), 1);
    deliver(d, mint_msg(evm_alice(), bob(), amt(10), 2, true, false, 840), 2);
    assert(d.registry.is_verified(alice()), 'A_NOT_VERIFIED');
    assert(d.registry.is_verified(bob()), 'B_NOT_VERIFIED');

    // One record, both wallets -- no iteration, no wallet left behind.
    deliver(d, identity_msg(evm_alice(), 3, false, false, 840), 3);
    assert(!d.registry.is_verified(alice()), 'A_STILL_VERIFIED');
    assert(!d.registry.is_verified(bob()), 'B_STILL_VERIFIED');
}

#[test]
fn a_bound_wallet_cannot_be_repointed_at_another_identity() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(10), 1, true, false, 840), 1);
    deliver(d, identity_msg(evm_alice(), 2, false, false, 840), 2);
    assert(!d.registry.is_verified(alice()), 'NOT_REVOKED');

    // Alice is revoked. A message binding her wallet to a clean identity must
    // not launder that away -- the tokens quarantine instead.
    deliver(d, mint_msg(evm_bob(), alice(), amt(50), 3, true, false, 840), 3);
    assert(d.registry.identity_of(alice()) == evm_alice(), 'REBOUND');
    assert(!d.registry.is_verified(alice()), 'LAUNDERED');
    assert(d.gateway.pending_of(alice()) == amt(50), 'NOT_QUARANTINED');
    assert(d.token.total_supply() == amt(10), 'MINTED_ANYWAY');
}

#[test]
fn a_global_pause_stops_every_account() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(10), 1, true, false, 840), 1);
    assert(d.registry.is_verified(alice()), 'NOT_VERIFIED');

    deliver(d, encode_global(GlobalMessage { seq: 1, paused: true }), 2);
    assert(!d.registry.is_verified(alice()), 'PAUSE_IGNORED');

    deliver(d, encode_global(GlobalMessage { seq: 2, paused: false }), 3);
    assert(d.registry.is_verified(alice()), 'UNPAUSE_IGNORED');
}

// ── Gateway access control ───────────────────────────────────────────────────

#[test]
#[should_panic(expected: 'ONLY_ENDPOINT')]
fn only_the_endpoint_may_deliver() {
    let d = deploy(false);
    start_cheat_caller_address(d.receiver.contract_address, mallory());
    d
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: peer(), nonce: 1 },
            Bytes32 { value: 1 },
            mint_msg(evm_alice(), alice(), amt(100), 1, true, false, 840),
            mallory(),
            Default::default(),
            0,
        );
}

#[test]
#[should_panic(expected: 'ONLY_PEER')]
fn only_the_configured_peer_may_deliver() {
    let d = deploy(false);
    start_cheat_caller_address(d.receiver.contract_address, endpoint_addr());
    d
        .receiver
        .lz_receive(
            Origin { src_eid: EVM_EID, sender: Bytes32 { value: 0xBAD }, nonce: 1 },
            Bytes32 { value: 1 },
            mint_msg(evm_alice(), alice(), amt(100), 1, true, false, 840),
            mallory(),
            Default::default(),
            0,
        );
}

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn the_registry_rejects_writes_from_anyone_but_the_gateway() {
    let d = deploy(false);
    start_cheat_caller_address(d.registry.contract_address, mallory());
    d.registry.apply_identity(evm_alice(), 1, true, false, 840);
}

#[test]
#[should_panic(expected: 'ONLY_GATEWAY')]
fn the_token_cannot_be_minted_by_anyone_but_the_gateway() {
    let d = deploy(false);
    deliver(d, identity_msg(evm_alice(), 1, true, false, 840), 1);
    start_cheat_caller_address(d.token.contract_address, mallory());
    d.token.bridge_mint(alice(), amt(1000));
}

// ── Bridge in ────────────────────────────────────────────────────────────────

#[test]
fn a_verified_bridge_in_mints_and_binds() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);

    assert(d.token.balance_of(alice()) == amt(1000), 'BALANCE');
    assert(d.token.total_supply() == amt(1000), 'SUPPLY');
    assert(d.registry.identity_of(alice()) == evm_alice(), 'BINDING');
    assert(d.registry.investor_country(alice()) == 840, 'COUNTRY');
    assert(d.gateway.pending_of(alice()) == 0, 'UNEXPECTED_PENDING');
}

#[test]
fn an_ineligible_recipient_is_quarantined_not_rejected() {
    let d = deploy(false);
    // The escrow already happened on the source chain, so refusing here would
    // strand it. The amount is held instead.
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, false, false, 840), 1);

    assert(d.token.balance_of(alice()) == 0, 'MINTED_TO_INELIGIBLE');
    assert(d.token.total_supply() == 0, 'SUPPLY_CREATED');
    assert(d.gateway.pending_of(alice()) == amt(1000), 'NOT_HELD');
    assert(d.gateway.total_pending() == amt(1000), 'TOTAL_PENDING');
}

#[test]
fn a_frozen_holder_is_quarantined_too() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, true, 840), 1);
    assert(d.token.balance_of(alice()) == 0, 'MINTED_TO_FROZEN');
    assert(d.gateway.pending_of(alice()) == amt(1000), 'NOT_HELD');
}

#[test]
fn quarantined_tokens_are_claimable_once_compliance_arrives() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, false, false, 840), 1);
    assert(d.gateway.pending_of(alice()) == amt(1000), 'NOT_HELD');

    // KYC completes on the source chain and someone pushes the update.
    deliver(d, identity_msg(evm_alice(), 2, true, false, 840), 2);

    // Permissionless release: a third party may pay the gas, funds still go to
    // the recipient the original message named.
    start_cheat_caller_address(d.gateway.contract_address, mallory());
    d.gateway.claim_pending(alice());
    stop_cheat_caller_address(d.gateway.contract_address);

    assert(d.token.balance_of(alice()) == amt(1000), 'NOT_RELEASED');
    assert(d.gateway.pending_of(alice()) == 0, 'PENDING_REMAINS');
    assert(d.gateway.total_pending() == 0, 'TOTAL_PENDING');
}

#[test]
#[should_panic(expected: 'STILL_INELIGIBLE')]
fn a_claim_before_compliance_arrives_is_refused() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, false, false, 840), 1);
    d.gateway.claim_pending(alice());
}

#[test]
fn a_snapshot_overtaken_by_a_revocation_quarantines() {
    let d = deploy(false);
    // Alice bridges out on the source chain, then is revoked before her mint
    // lands. The revocation, carrying the higher sequence, arrives first.
    deliver(d, identity_msg(evm_alice(), 9, false, false, 840), 1);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 5, true, false, 840), 2);

    assert(d.token.balance_of(alice()) == 0, 'MINTED_AFTER_REVOKE');
    assert(d.gateway.pending_of(alice()) == amt(1000), 'NOT_HELD');
    assert(d.registry.record(evm_alice()).seq == 9, 'SEQ_REGRESSED');
}

#[test]
#[should_panic(expected: "BRIDGE_UNKNOWN_KIND")]
fn an_unknown_message_kind_reverts_for_retry() {
    let d = deploy(false);
    // Only a configured peer can reach this, so an unrecognised kind is a
    // version or wiring bug: revert and let the endpoint hold it.
    let mut message: ByteArray = Default::default();
    message.append_byte(99);
    deliver(d, message, 1);
}

// ── Mirrored global rules ────────────────────────────────────────────────────

/// The replication step an issuer performs when the asset is allowed onto the
/// bridge: the EVM rule set, restated as a spec.
fn cap_spec(max: u256) -> ComplianceSpec {
    ComplianceSpec {
        country_allow_enabled: false,
        allowed_countries: array![],
        country_restrict_enabled: false,
        restricted_countries: array![],
        max_balance_enabled: true,
        max_balance: max,
        supply_limit_enabled: false,
        supply_limit: 0,
        transfer_restrict_enabled: false,
        allowed_identities: array![],
    }
}

#[test]
fn the_mirrored_holding_cap_is_enforced_on_bridge_in() {
    let d = deploy(false);
    start_cheat_caller_address(d.compliance.contract_address, owner());
    d.compliance.apply_spec(cap_spec(amt(500)));
    stop_cheat_caller_address(d.compliance.contract_address);

    // Over the cap: held rather than minted -- the cap is a compliance rule, so
    // breaching it is a policy outcome, not a protocol error.
    deliver(d, mint_msg(evm_alice(), alice(), amt(600), 1, true, false, 840), 2);
    assert(d.token.balance_of(alice()) == 0, 'CAP_NOT_ENFORCED');
    assert(d.gateway.pending_of(alice()) == amt(600), 'NOT_HELD');

    // Under it: minted.
    deliver(d, mint_msg(evm_bob(), bob(), amt(400), 2, true, false, 840), 3);
    assert(d.token.balance_of(bob()) == amt(400), 'UNDER_CAP_BLOCKED');
}

// ── The twin as an ordinary permissioned asset ───────────────────────────────
// It has to be usable on Starknet, not just mintable, or bridging it is
// pointless. These cover the transfer path the Veil pool would drive.

#[test]
fn verified_holders_can_transfer_the_twin() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    deliver(d, mint_msg(evm_bob(), bob(), amt(0), 2, true, false, 76), 2);

    start_cheat_caller_address(d.token.contract_address, alice());
    d.token.transfer(bob(), amt(250));
    stop_cheat_caller_address(d.token.contract_address);

    assert(d.token.balance_of(alice()) == amt(750), 'SENDER_BALANCE');
    assert(d.token.balance_of(bob()) == amt(250), 'RECIPIENT_BALANCE');
    assert(d.token.total_supply() == amt(1000), 'SUPPLY_CHANGED');
}

#[test]
#[should_panic(expected: 'RECIPIENT_NOT_VERIFIED')]
fn a_transfer_to_an_unmirrored_wallet_reverts() {
    let d = deploy(false);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);

    // carol has no binding at all: the mirror has never heard of her.
    start_cheat_caller_address(d.token.contract_address, alice());
    d.token.transfer(carol(), amt(1));
}

#[test]
// The cap is a compliance MODULE rule now, so it surfaces through the token's
// compliance check rather than as its own assertion -- same path a T-REX
// MaxBalanceModule rejection takes on the source chain.
#[should_panic(expected: 'COMPLIANCE_BLOCKED')]
fn a_transfer_breaching_the_mirrored_cap_reverts() {
    let d = deploy(false);
    start_cheat_caller_address(d.compliance.contract_address, owner());
    d.compliance.apply_spec(cap_spec(amt(500)));
    stop_cheat_caller_address(d.compliance.contract_address);
    deliver(d, mint_msg(evm_alice(), alice(), amt(400), 1, true, false, 840), 2);
    deliver(d, mint_msg(evm_bob(), bob(), amt(200), 2, true, false, 76), 3);

    // bob holds 200; another 400 would put him over the mirrored cap of 500.
    start_cheat_caller_address(d.token.contract_address, alice());
    d.token.transfer(bob(), amt(400));
}

#[test]
#[should_panic(expected: 'SENDER_NOT_VERIFIED')]
fn a_stale_mirror_freezes_ordinary_transfers_too() {
    let d = deploy(false);
    start_cheat_block_timestamp_global(1000);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    deliver(d, mint_msg(evm_bob(), bob(), amt(0), 2, true, false, 76), 2);

    // Nothing was revoked; the mirror simply aged out. The asset stops moving
    // until someone refreshes it, which anyone can do.
    start_cheat_block_timestamp_global(1000 + STALENESS + 1);
    start_cheat_caller_address(d.token.contract_address, alice());
    d.token.transfer(bob(), amt(1));
}

// ── Bridge back ──────────────────────────────────────────────────────────────

#[test]
fn bridging_back_burns_and_emits_the_right_bytes() {
    let d = deploy(true);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    assert(d.token.total_supply() == amt(1000), 'SUPPLY');

    start_cheat_caller_address(d.gateway.contract_address, alice());
    d
        .gateway
        .bridge_back(
            amt(400),
            evm_alice(),
            MessagingFee { native_fee: 0, lz_token_fee: 0 },
            200000,
            alice(),
        );
    stop_cheat_caller_address(d.gateway.contract_address);

    assert(d.token.balance_of(alice()) == amt(600), 'NOT_BURNED');
    assert(d.token.total_supply() == amt(600), 'SUPPLY_AFTER_BURN');

    // The bytes the endpoint received are exactly an UNLOCK for 400 to Alice's
    // EVM address -- what the lockbox will decode.
    assert(d.endpoint.send_count() == 1, 'SEND_COUNT');
    assert(d.endpoint.last_dst_eid() == EVM_EID, 'DST_EID');
    assert(d.endpoint.last_receiver() == peer(), 'RECEIVER');
    let sent = d.endpoint.last_message();
    assert(sent == encode_unlock(evm_alice(), amt(400)), 'WIRE_BYTES');
    assert(sent.at(0).unwrap() == 4, 'KIND');
}

#[test]
#[should_panic(expected: 'SENDER_NOT_VERIFIED')]
fn a_revoked_holder_cannot_bridge_back_out() {
    let d = deploy(true);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    deliver(d, identity_msg(evm_alice(), 2, false, false, 840), 2);

    // Freezing must mean the holder cannot move value, cross-chain included.
    // Their route out is the issuer's `forced_transfer`.
    start_cheat_caller_address(d.gateway.contract_address, alice());
    d
        .gateway
        .bridge_back(
            amt(400),
            evm_alice(),
            MessagingFee { native_fee: 0, lz_token_fee: 0 },
            200000,
            alice(),
        );
}

#[test]
#[should_panic(expected: 'SENDER_NOT_VERIFIED')]
fn a_stale_mirror_blocks_the_exit_too() {
    let d = deploy(true);
    start_cheat_block_timestamp_global(1000);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    start_cheat_block_timestamp_global(1000 + STALENESS + 1);

    start_cheat_caller_address(d.gateway.contract_address, alice());
    d
        .gateway
        .bridge_back(
            amt(1),
            evm_alice(),
            MessagingFee { native_fee: 0, lz_token_fee: 0 },
            200000,
            alice(),
        );
}

#[test]
fn the_fee_is_collected_from_the_caller_and_approved_to_the_endpoint() {
    let d = deploy(true);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);

    let fee = amt(5000);
    d.native.mint(alice(), fee);
    let native = IERC20Dispatcher { contract_address: d.native_addr };
    start_cheat_caller_address(d.native_addr, alice());
    native.approve(d.gateway.contract_address, fee);
    stop_cheat_caller_address(d.native_addr);

    start_cheat_caller_address(d.gateway.contract_address, alice());
    d
        .gateway
        .bridge_back(
            amt(100),
            evm_alice(),
            MessagingFee { native_fee: fee, lz_token_fee: 0 },
            200000,
            alice(),
        );
    stop_cheat_caller_address(d.gateway.contract_address);

    assert(native.balance_of(alice()) == 0, 'FEE_NOT_TAKEN');
    assert(native.balance_of(d.gateway.contract_address) == fee, 'FEE_NOT_HELD');
    assert(
        native.allowance(d.gateway.contract_address, d.endpoint.contract_address) == fee,
        'ENDPOINT_NOT_APPROVED',
    );
}

#[test]
#[should_panic(expected: 'FEE_ALLOWANCE_TOO_LOW')]
fn bridging_back_without_approving_the_fee_fails_before_any_send() {
    let d = deploy(true);
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    d.native.mint(alice(), amt(5000));

    start_cheat_caller_address(d.gateway.contract_address, alice());
    d
        .gateway
        .bridge_back(
            amt(100),
            evm_alice(),
            MessagingFee { native_fee: amt(5000), lz_token_fee: 0 },
            200000,
            alice(),
        );
}

// ── Supply invariant ─────────────────────────────────────────────────────────

#[test]
fn supply_tracks_escrow_across_a_round_trip() {
    let d = deploy(true);
    // Two bridge-ins: one mints, one quarantines. Escrowed on the source chain
    // is 1500; supply + pending must equal it at every step.
    deliver(d, mint_msg(evm_alice(), alice(), amt(1000), 1, true, false, 840), 1);
    deliver(d, mint_msg(evm_bob(), bob(), amt(500), 2, false, false, 840), 2);
    assert(d.token.total_supply() + d.gateway.total_pending() == amt(1500), 'AFTER_IN');

    // Bob's KYC lands and he claims: still 1500, just distributed differently.
    deliver(d, identity_msg(evm_bob(), 3, true, false, 840), 3);
    d.gateway.claim_pending(bob());
    assert(d.token.total_supply() == amt(1500), 'AFTER_CLAIM');
    assert(d.gateway.total_pending() == 0, 'PENDING_AFTER_CLAIM');

    // Alice exits with 400; the twin supply drops to match what stays escrowed.
    start_cheat_caller_address(d.gateway.contract_address, alice());
    d
        .gateway
        .bridge_back(
            amt(400),
            evm_alice(),
            MessagingFee { native_fee: 0, lz_token_fee: 0 },
            200000,
            alice(),
        );
    stop_cheat_caller_address(d.gateway.contract_address);
    assert(d.token.total_supply() + d.gateway.total_pending() == amt(1100), 'AFTER_OUT');
}
