// Semantic conformance tests for MirroredCompliance.
//
// These are the tests that make "replicate the EVM rule set" a checkable claim
// rather than a hopeful one. Each asserts the exact behaviour of the
// corresponding @tokenysolutions/t-rex v4.1.6 module, including the parts that
// are easy to get subtly wrong and that a looser port would get away with until
// an issuer noticed:
//
//   * country rules look at the RECEIVER only -- a sender in a banned country
//     is irrelevant;
//   * MaxBalance rejects on the raw value before it even looks at balances;
//   * MaxBalance counts per IDENTITY, so two wallets of one investor share one
//     allowance -- the case a per-address port silently gets wrong, and the one
//     that matters most here because bridging naturally creates second wallets;
//   * SupplyLimit binds mints only;
//   * TransferRestrict is an OR over the two parties, and exempts mint/burn.
//
// No LayerZero here: the mirror's gateway is set to an address the test
// impersonates, so identities can be written directly.

use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use veil_bridge::bridged_token::{
    IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait,
};
use veil_bridge::compliance::rules::{
    ComplianceSpec, IMirroredComplianceDispatcher, IMirroredComplianceDispatcherTrait,
};
use veil_bridge::mirrored_registry::{
    IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
};

fn owner() -> ContractAddress {
    1000.try_into().unwrap()
}
/// Stands in for both the bridge gateway (writes the mirror, mints) and, where
/// a test needs it, the token calling the compliance hooks.
fn gateway() -> ContractAddress {
    2000.try_into().unwrap()
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
fn mallory() -> ContractAddress {
    666.try_into().unwrap()
}
fn zero() -> ContractAddress {
    0.try_into().unwrap()
}

fn evm_alice() -> felt252 {
    0xA11CE
}
fn evm_bob() -> felt252 {
    0xB0B
}
fn evm_carol() -> felt252 {
    0xCA401
}

const US: u16 = 840;
const FR: u16 = 250;
const KP: u16 = 408;

fn amt(n: u128) -> u256 {
    u256 { low: n, high: 0 }
}

fn empty_spec() -> ComplianceSpec {
    ComplianceSpec {
        country_allow_enabled: false,
        allowed_countries: array![],
        country_restrict_enabled: false,
        restricted_countries: array![],
        max_balance_enabled: false,
        max_balance: 0,
        supply_limit_enabled: false,
        supply_limit: 0,
        transfer_restrict_enabled: false,
        allowed_identities: array![],
    }
}

#[derive(Copy, Drop)]
struct Fixture {
    registry: IVeilMirroredRegistryDispatcher,
    compliance: IMirroredComplianceDispatcher,
    token: IVeilBridgedERC3643Dispatcher,
}

fn setup() -> Fixture {
    let registry_class = declare("VeilMirroredRegistry").unwrap().contract_class();
    // staleness_window = 0: expiry is exercised in test_bridge; here it would
    // only add noise to rules that have nothing to do with freshness.
    let (registry_addr, _) = registry_class.deploy(@array![owner().into(), 0]).unwrap();

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
    let compliance = IMirroredComplianceDispatcher { contract_address: compliance_addr };
    let token = IVeilBridgedERC3643Dispatcher { contract_address: token_addr };

    start_cheat_caller_address(registry_addr, owner());
    registry.set_gateway(gateway());
    stop_cheat_caller_address(registry_addr);

    start_cheat_caller_address(token_addr, owner());
    token.set_gateway(gateway());
    stop_cheat_caller_address(token_addr);

    start_cheat_caller_address(compliance_addr, owner());
    compliance.set_token(token_addr);
    stop_cheat_caller_address(compliance_addr);

    Fixture { registry, compliance, token }
}

fn apply(f: Fixture, spec: ComplianceSpec) {
    start_cheat_caller_address(f.compliance.contract_address, owner());
    f.compliance.apply_spec(spec);
    stop_cheat_caller_address(f.compliance.contract_address);
}

fn bind(f: Fixture, wallet: ContractAddress, identity: felt252, country: u16, seq: u64) {
    start_cheat_caller_address(f.registry.contract_address, gateway());
    f.registry.apply_identity(identity, seq, true, false, country);
    f.registry.bind(wallet, identity);
    stop_cheat_caller_address(f.registry.contract_address);
}

fn mint(f: Fixture, to: ContractAddress, amount: u256) {
    start_cheat_caller_address(f.token.contract_address, gateway());
    f.token.bridge_mint(to, amount);
    stop_cheat_caller_address(f.token.contract_address);
}

// ── CountryAllowModule ───────────────────────────────────────────────────────

#[test]
fn country_allow_checks_the_receiver_only() {
    let f = setup();
    bind(f, alice(), evm_alice(), KP, 1); // sender in a country that is NOT allowed
    bind(f, bob(), evm_bob(), US, 2);
    bind(f, carol(), evm_carol(), FR, 3);

    let mut spec = empty_spec();
    spec.country_allow_enabled = true;
    spec.allowed_countries = array![US];
    apply(f, spec);

    // Upstream reads `_getCountry(_compliance, _to)` and nothing else, so a
    // sender sitting in a disallowed country is irrelevant.
    assert(f.compliance.can_transfer(alice(), bob(), amt(1)), 'RECEIVER_US_BLOCKED');
    assert(!f.compliance.can_transfer(bob(), carol(), amt(1)), 'RECEIVER_FR_ALLOWED');
    assert(f.compliance.is_country_allowed(US), 'US_NOT_ALLOWED');
    assert(!f.compliance.is_country_allowed(FR), 'FR_ALLOWED');
}

#[test]
fn country_restrict_checks_the_receiver_only() {
    let f = setup();
    bind(f, alice(), evm_alice(), KP, 1);
    bind(f, bob(), evm_bob(), US, 2);

    let mut spec = empty_spec();
    spec.country_restrict_enabled = true;
    spec.restricted_countries = array![KP];
    apply(f, spec);

    assert(f.compliance.can_transfer(alice(), bob(), amt(1)), 'SENDER_KP_BLOCKED');
    assert(!f.compliance.can_transfer(bob(), alice(), amt(1)), 'RECEIVER_KP_ALLOWED');
}

// ── MaxBalanceModule ─────────────────────────────────────────────────────────

#[test]
fn max_balance_rejects_on_the_raw_value_before_looking_at_balances() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);
    bind(f, bob(), evm_bob(), US, 2);

    let mut spec = empty_spec();
    spec.max_balance_enabled = true;
    spec.max_balance = amt(500);
    apply(f, spec);

    // Upstream's first branch: `if (_value > _maxBalance) return false`, with
    // the receiver holding nothing at all.
    assert(f.compliance.id_balance(evm_bob()) == 0, 'PRECONDITION');
    assert(!f.compliance.can_transfer(alice(), bob(), amt(501)), 'RAW_VALUE_ALLOWED');
    assert(f.compliance.can_transfer(alice(), bob(), amt(500)), 'AT_CAP_BLOCKED');
}

#[test]
fn max_balance_counts_per_identity_not_per_wallet() {
    let f = setup();
    // One investor, two Starknet wallets -- exactly what bridging produces when
    // someone brings tokens to a second address.
    bind(f, alice(), evm_alice(), US, 1);
    bind(f, bob(), evm_alice(), US, 2);
    bind(f, carol(), evm_carol(), US, 3);

    let mut spec = empty_spec();
    spec.max_balance_enabled = true;
    spec.max_balance = amt(500);
    apply(f, spec);

    mint(f, alice(), amt(300));
    assert(f.compliance.id_balance(evm_alice()) == amt(300), 'ID_BALANCE_AFTER_MINT');

    // bob's own balance is 0, but he shares alice's identity, so only 200 of
    // headroom remains. A per-address port would wrongly allow 500 here.
    assert(!f.compliance.can_transfer(carol(), bob(), amt(250)), 'SHARED_CAP_IGNORED');
    assert(f.compliance.can_transfer(carol(), bob(), amt(200)), 'HEADROOM_BLOCKED');
}

#[test]
fn max_balance_follows_tokens_as_they_move() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);
    bind(f, bob(), evm_bob(), US, 2);

    let mut spec = empty_spec();
    spec.max_balance_enabled = true;
    spec.max_balance = amt(500);
    apply(f, spec);

    mint(f, alice(), amt(400));
    start_cheat_caller_address(f.token.contract_address, alice());
    f.token.transfer(bob(), amt(150));
    stop_cheat_caller_address(f.token.contract_address);

    // The hooks kept both ledgers straight without anyone re-syncing.
    assert(f.compliance.id_balance(evm_alice()) == amt(250), 'SENDER_LEDGER');
    assert(f.compliance.id_balance(evm_bob()) == amt(150), 'RECIPIENT_LEDGER');
}

#[test]
fn an_unbound_wallet_fails_every_identity_keyed_rule() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);

    let mut spec = empty_spec();
    spec.max_balance_enabled = true;
    spec.max_balance = amt(500);
    apply(f, spec);

    // carol has no identity, so there is no allowance to charge against. Fail
    // closed rather than treat "unknown" as "zero used".
    assert(!f.compliance.can_transfer(alice(), carol(), amt(1)), 'UNBOUND_ALLOWED');
}

// ── SupplyLimitModule ────────────────────────────────────────────────────────

#[test]
fn supply_limit_binds_mints_only() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);
    bind(f, bob(), evm_bob(), US, 2);

    let mut spec = empty_spec();
    spec.supply_limit_enabled = true;
    spec.supply_limit = amt(1000);
    apply(f, spec);

    mint(f, alice(), amt(900));

    // Upstream gates on `_from == address(0)`: a mint past the cap is refused,
    // a transfer of any size between holders is not its business.
    assert(!f.compliance.can_transfer(zero(), bob(), amt(200)), 'OVER_LIMIT_MINT_ALLOWED');
    assert(f.compliance.can_transfer(zero(), bob(), amt(100)), 'AT_LIMIT_MINT_BLOCKED');
    assert(f.compliance.can_transfer(alice(), bob(), amt(900)), 'TRANSFER_GATED_BY_SUPPLY');
}

#[test]
#[should_panic(expected: 'COMPLIANCE_BLOCKED')]
fn a_mint_past_the_supply_limit_is_refused_by_the_token() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);
    let mut spec = empty_spec();
    spec.supply_limit_enabled = true;
    spec.supply_limit = amt(1000);
    apply(f, spec);
    mint(f, alice(), amt(1001));
}

// ── TransferRestrictModule ───────────────────────────────────────────────────

#[test]
fn transfer_restrict_is_an_or_over_the_two_parties() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);
    bind(f, bob(), evm_bob(), US, 2);
    bind(f, carol(), evm_carol(), US, 3);

    let mut spec = empty_spec();
    spec.transfer_restrict_enabled = true;
    spec.allowed_identities = array![evm_alice()];
    apply(f, spec);

    // Either side being listed clears it -- an OR, not an AND. Getting this
    // backwards would quietly block most of an issuer's legitimate traffic.
    assert(f.compliance.can_transfer(alice(), bob(), amt(1)), 'SENDER_LISTED_BLOCKED');
    assert(f.compliance.can_transfer(bob(), alice(), amt(1)), 'RECEIVER_LISTED_BLOCKED');
    assert(!f.compliance.can_transfer(bob(), carol(), amt(1)), 'NEITHER_LISTED_ALLOWED');
}

#[test]
fn transfer_restrict_exempts_mint_and_burn() {
    let f = setup();
    bind(f, bob(), evm_bob(), US, 1);

    let mut spec = empty_spec();
    spec.transfer_restrict_enabled = true;
    spec.allowed_identities = array![evm_alice()];
    apply(f, spec);

    // Upstream returns true outright when either party is the zero address.
    assert(f.compliance.can_transfer(zero(), bob(), amt(1)), 'MINT_BLOCKED');
    assert(f.compliance.can_transfer(bob(), zero(), amt(1)), 'BURN_BLOCKED');
}

// ── Replication mechanics ────────────────────────────────────────────────────

#[test]
fn apply_spec_replaces_rather_than_merges() {
    let f = setup();
    let mut first = empty_spec();
    first.country_allow_enabled = true;
    first.allowed_countries = array![US, FR];
    first.transfer_restrict_enabled = true;
    first.allowed_identities = array![evm_alice(), evm_bob()];
    apply(f, first);
    assert(f.compliance.is_country_allowed(FR), 'FR_NOT_SET');
    assert(f.compliance.is_user_allowed(evm_bob()), 'BOB_NOT_SET');

    // Re-applying a narrower spec must CLEAR what the old one set. Merging
    // would silently keep a country the issuer just withdrew.
    let mut second = empty_spec();
    second.country_allow_enabled = true;
    second.allowed_countries = array![US];
    second.transfer_restrict_enabled = true;
    second.allowed_identities = array![evm_alice()];
    apply(f, second);

    assert(f.compliance.is_country_allowed(US), 'US_LOST');
    assert(!f.compliance.is_country_allowed(FR), 'FR_SURVIVED');
    assert(f.compliance.is_user_allowed(evm_alice()), 'ALICE_LOST');
    assert(!f.compliance.is_user_allowed(evm_bob()), 'BOB_SURVIVED');
}

#[test]
fn export_spec_round_trips_what_was_applied() {
    let f = setup();
    let mut spec = empty_spec();
    spec.country_allow_enabled = true;
    spec.allowed_countries = array![US, FR];
    spec.country_restrict_enabled = true;
    spec.restricted_countries = array![KP];
    spec.max_balance_enabled = true;
    spec.max_balance = amt(5000);
    spec.supply_limit_enabled = true;
    spec.supply_limit = amt(1000000);
    spec.transfer_restrict_enabled = true;
    spec.allowed_identities = array![evm_alice()];
    apply(f, spec);

    // This is what makes a deployment auditable against the EVM export that
    // produced it: read it back and diff, no trust in the deploy script.
    let out = f.compliance.export_spec();
    assert(out.country_allow_enabled, 'ALLOW_FLAG');
    assert(out.allowed_countries == array![US, FR], 'ALLOWED');
    assert(out.restricted_countries == array![KP], 'RESTRICTED');
    assert(out.max_balance == amt(5000), 'MAX_BALANCE');
    assert(out.supply_limit == amt(1000000), 'SUPPLY_LIMIT');
    assert(out.allowed_identities == array![evm_alice()], 'IDENTITIES');
}

#[test]
fn a_disabled_module_stops_binding_even_with_config_present() {
    let f = setup();
    bind(f, alice(), evm_alice(), KP, 1);
    bind(f, bob(), evm_bob(), KP, 2);

    let mut spec = empty_spec();
    spec.country_allow_enabled = false; // config present, module off
    spec.allowed_countries = array![US];
    apply(f, spec);

    assert(f.compliance.can_transfer(alice(), bob(), amt(1)), 'DISABLED_STILL_ENFORCED');
}

#[test]
#[should_panic(expected: 'ONLY_OWNER')]
fn only_the_owner_may_replicate_a_spec() {
    let f = setup();
    start_cheat_caller_address(f.compliance.contract_address, mallory());
    f.compliance.apply_spec(empty_spec());
}

#[test]
#[should_panic(expected: 'ONLY_TOKEN')]
fn only_the_token_may_move_the_identity_ledger() {
    let f = setup();
    bind(f, alice(), evm_alice(), US, 1);
    // Otherwise anyone could zero their own recorded holdings and mint past the
    // cap.
    start_cheat_caller_address(f.compliance.contract_address, mallory());
    f.compliance.destroyed(alice(), amt(100));
}

// ── Cross-language encoding ──────────────────────────────────────────────────

#[test]
fn the_spec_serializes_to_the_felts_the_js_tool_produces() {
    // The replication path crosses a language boundary: `tools/spec.js` builds
    // apply_spec calldata in JavaScript from its own reading of Cairo's derived
    // Serde. Nothing else checks that reading -- a field reordered here would
    // still compile, still pass every Cairo test, and quietly land the max
    // balance in the supply limit on a live deployment.
    //
    // So this asserts the ACTUAL Serde output for a fixed spec, and
    // tools/spec.test.js asserts the identical vector from the JS side. The two
    // together are the contract between them.
    let spec = ComplianceSpec {
        country_allow_enabled: true,
        allowed_countries: array![840, 250],
        country_restrict_enabled: true,
        restricted_countries: array![408],
        max_balance_enabled: true,
        max_balance: amt(5000),
        supply_limit_enabled: true,
        supply_limit: amt(1000000),
        transfer_restrict_enabled: true,
        allowed_identities: array![0xA11CE],
    };

    let mut encoded: Array<felt252> = array![];
    spec.serialize(ref encoded);

    let expected: Array<felt252> = array![
        1,        // country_allow_enabled
        2, 840, 250,   // allowed_countries: len, items
        1,        // country_restrict_enabled
        1, 408,   // restricted_countries
        1,        // max_balance_enabled
        5000, 0,  // max_balance: u256 low, high
        1,        // supply_limit_enabled
        1000000, 0, // supply_limit
        1,        // transfer_restrict_enabled
        1, 0xA11CE, // allowed_identities
    ];
    assert(encoded == expected, 'SERDE_LAYOUT_CHANGED');
}
