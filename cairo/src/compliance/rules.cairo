// T-REX modular compliance, restated for the bridged twin.
//
// The point of this contract is replication. When an asset is allowed onto the
// bridge, its EVM compliance rule set has to be reproduced here, and that
// reproduction has to be checkable rather than hopeful. So rather than a bag of
// separate rule contracts to deploy and wire, the five mirrorable T-REX modules
// are implemented natively in ONE contract configured by ONE `apply_spec` call.
// `tools/export-compliance.js` reads the EVM side and emits exactly that spec.
//
// Semantics are copied from @tokenysolutions/t-rex v4.1.6, module by module,
// including the parts that are easy to get wrong:
//
//   CountryAllowModule      only the RECEIVER's country is checked.
//   CountryRestrictModule   only the RECEIVER's country is checked.
//   MaxBalanceModule        `value <= max` AND `balance(identity(to)) + value
//                           <= max`; the balance is per IDENTITY, not per
//                           address, and is maintained by the transfer hooks.
//   SupplyLimitModule       applies ONLY on mint (`from == 0`).
//   TransferRestrictModule  mint and burn always pass; otherwise `allowed(from)
//                           OR allowed(to)` -- an or, not an and.
//
// Two deliberate divergences from a literal port, both forced by the chain
// boundary and both in the safe direction:
//
//   Identities are EVM accounts. T-REX keys MaxBalance and TransferRestrict on
//   an ONCHAINID contract address. Here the equivalent handle is the EVM
//   account the mirror already keys eligibility on, resolved through the
//   wallet binding. This is what makes per-identity balance correct when one
//   EVM identity backs several Starknet wallets -- they share one balance, as
//   they would share one ONCHAINID on the source chain.
//
//   An unbound wallet has no identity, so every identity-keyed rule fails
//   closed for it. It could not have received tokens in the first place.
//
// Anything outside these five (time windows, exchange limits, transfer fees,
// conditional approvals) is NOT mirrored: they are stateful per-transfer rules
// whose source-chain state cannot be reconstructed from a snapshot. Register a
// custom `IComplianceRule` through `add_rule` for those, and see ../README.md
// for the honest list of what that means.

use starknet::ContractAddress;
use super::super::mirrored_registry::LocalIdentity;

#[starknet::interface]
pub trait IComplianceRule<TContractState> {
    fn can_transfer(
        self: @TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
}

#[starknet::interface]
pub trait IMirrorLookup<TContractState> {
    fn identity_of(self: @TContractState, sn_account: ContractAddress) -> felt252;
    fn investor_country(self: @TContractState, account: ContractAddress) -> u16;
    /// Registered directly on this chain rather than bound to an EVM account:
    /// a Veil pool, or another contract with no counterpart on the source
    /// chain: a Veil pool, or another contract with no counterpart on the
    /// source chain. Such an account is a VENUE, not an investor.
    fn local_identity(self: @TContractState, sn_account: ContractAddress) -> LocalIdentity;
}

#[starknet::interface]
pub trait ITokenSupply<TContractState> {
    fn total_supply(self: @TContractState) -> u256;
}

/// One EVM token's rule set, in the form `apply_spec` consumes and
/// `tools/export-compliance.js` produces.
#[derive(Drop, Serde, Clone)]
pub struct ComplianceSpec {
    pub country_allow_enabled: bool,
    pub allowed_countries: Array<u16>,
    pub country_restrict_enabled: bool,
    pub restricted_countries: Array<u16>,
    pub max_balance_enabled: bool,
    pub max_balance: u256,
    pub supply_limit_enabled: bool,
    pub supply_limit: u256,
    pub transfer_restrict_enabled: bool,
    pub allowed_identities: Array<felt252>,
}

#[starknet::interface]
pub trait IMirroredCompliance<TContractState> {
    // ── What the twin calls ─────────────────────────────────────────────────
    /// `from == 0` means mint and `to == 0` means burn, matching the convention
    /// T-REX modules branch on.
    fn can_transfer(
        self: @TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
    /// Balance-tracking hooks, named as in `IModularCompliance`. Token only.
    fn transferred(
        ref self: TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    );
    fn created(ref self: TContractState, to: ContractAddress, amount: u256);
    fn destroyed(ref self: TContractState, from: ContractAddress, amount: u256);

    // ── Replication ─────────────────────────────────────────────────────────
    /// Replace the whole rule set in one call. Idempotent: applying the same
    /// spec twice leaves identical state, and applying a different one clears
    /// what the previous spec set rather than merging into it.
    fn apply_spec(ref self: TContractState, spec: ComplianceSpec);
    /// The current rule set, in the same shape `apply_spec` takes, so a
    /// deployment can be diffed against the EVM export that produced it.
    fn export_spec(self: @TContractState) -> ComplianceSpec;

    // ── Reads (mirror the T-REX module getters) ─────────────────────────────
    fn is_country_allowed(self: @TContractState, country: u16) -> bool;
    fn is_country_restricted(self: @TContractState, country: u16) -> bool;
    fn max_balance(self: @TContractState) -> u256;
    fn supply_limit(self: @TContractState) -> u256;
    fn is_user_allowed(self: @TContractState, identity: felt252) -> bool;
    fn id_balance(self: @TContractState, identity: felt252) -> u256;

    // ── Custom rules for anything the five modules do not cover ─────────────
    fn add_rule(ref self: TContractState, rule: ContractAddress);
    fn remove_rule(ref self: TContractState, rule: ContractAddress);
    fn get_rules(self: @TContractState) -> Array<ContractAddress>;

    // ── Wiring ──────────────────────────────────────────────────────────────
    fn set_token(ref self: TContractState, token: ContractAddress);
    fn token(self: @TContractState) -> ContractAddress;
    fn registry(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

#[starknet::contract]
pub mod MirroredCompliance {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::{
        ComplianceSpec, IComplianceRuleDispatcher, IComplianceRuleDispatcherTrait,
        IMirrorLookupDispatcher, IMirrorLookupDispatcherTrait, IMirroredCompliance,
        ITokenSupplyDispatcher, ITokenSupplyDispatcherTrait,
    };

    #[derive(Drop, starknet::Event)]
    pub struct SpecApplied {
        pub country_allow_enabled: bool,
        pub allowed_country_count: u32,
        pub country_restrict_enabled: bool,
        pub restricted_country_count: u32,
        pub max_balance_enabled: bool,
        pub max_balance: u256,
        pub supply_limit_enabled: bool,
        pub supply_limit: u256,
        pub transfer_restrict_enabled: bool,
        pub allowed_identity_count: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RuleAdded {
        #[key]
        pub rule: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RuleRemoved {
        #[key]
        pub rule: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        #[key]
        pub previous_owner: ContractAddress,
        #[key]
        pub new_owner: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        SpecApplied: SpecApplied,
        RuleAdded: RuleAdded,
        RuleRemoved: RuleRemoved,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        registry: ContractAddress,
        token: ContractAddress,

        // CountryAllowModule
        country_allow_enabled: bool,
        country_allowed: Map<u16, bool>,
        allowed_list: Map<u32, u16>,
        allowed_count: u32,

        // CountryRestrictModule
        country_restrict_enabled: bool,
        country_restricted: Map<u16, bool>,
        restricted_list: Map<u32, u16>,
        restricted_count: u32,

        // MaxBalanceModule. Balances are per EVM identity, kept by the hooks.
        max_balance_enabled: bool,
        max_balance: u256,
        id_balance: Map<felt252, u256>,

        // SupplyLimitModule
        supply_limit_enabled: bool,
        supply_limit: u256,

        // TransferRestrictModule
        transfer_restrict_enabled: bool,
        user_allowed: Map<felt252, bool>,
        allowed_id_list: Map<u32, felt252>,
        allowed_id_count: u32,

        // Custom rules, 0-based slots [0, rule_count); rule -> slot+1 sentinel.
        rule_count: u32,
        rules: Map<u32, ContractAddress>,
        rule_indices: Map<ContractAddress, u32>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, registry: ContractAddress) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        assert(!registry.is_zero(), 'ZERO_REGISTRY');
        self.owner.write(owner);
        self.registry.write(registry);
    }

    #[abi(embed_v0)]
    impl MirroredComplianceImpl of IMirroredCompliance<ContractState> {
        fn can_transfer(
            self: @ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            let is_mint = from.is_zero();
            let is_burn = to.is_zero();

            // SupplyLimitModule: mint only.
            if is_mint && self.supply_limit_enabled.read() {
                let supply = ITokenSupplyDispatcher { contract_address: self.token.read() }
                    .total_supply();
                if supply + amount > self.supply_limit.read() {
                    return false;
                }
            }

            if !is_burn {
                let mirror = IMirrorLookupDispatcher { contract_address: self.registry.read() };

                // CountryAllowModule / CountryRestrictModule: receiver only.
                if self.country_allow_enabled.read() || self.country_restrict_enabled.read() {
                    let country = mirror.investor_country(to);
                    if self.country_allow_enabled.read()
                        && !self.country_allowed.read(country) {
                        return false;
                    }
                    if self.country_restrict_enabled.read()
                        && self.country_restricted.read(country) {
                        return false;
                    }
                }

                // MaxBalanceModule, keyed on the receiver's EVM identity.
                //
                // A VENUE is exempt. A holding cap is a per-investor rule -- how
                // much of this asset one investor may hold -- and a Veil pool is
                // not an investor: it is where every investor's position lives,
                // so its balance is the sum of many people's and would breach
                // any cap immediately. It also has no EVM identity to key on.
                // Applying the cap to it would not enforce anything; it would
                // just make pool delivery impossible, which is the only way in.
                //
                // The investor-side cap is still enforced, on the way in, by the
                // gateway's `can_bridge_mint(recipient)` check against the
                // recipient's own identity -- so this exemption moves nothing.
                if self.max_balance_enabled.read() && !mirror.local_identity(to).allowed {
                    let cap = self.max_balance.read();
                    if amount > cap {
                        return false;
                    }
                    let id_to = mirror.identity_of(to);
                    if id_to == 0 {
                        return false;
                    }
                    if self.id_balance.read(id_to) + amount > cap {
                        return false;
                    }
                }
            }

            // TransferRestrictModule: mint and burn pass unconditionally, and
            // so does a venue -- an allow-list of investors says nothing about
            // the pool they all settle through.
            if self.transfer_restrict_enabled.read() && !is_mint && !is_burn {
                let mirror = IMirrorLookupDispatcher { contract_address: self.registry.read() };
                if mirror.local_identity(to).allowed {
                    return self.custom_rules_allow(from, to, amount);
                }
                let id_from = mirror.identity_of(from);
                let id_to = mirror.identity_of(to);
                // An OR, matching upstream: either party being allow-listed
                // clears the transfer.
                if !(self.user_allowed.read(id_from) || self.user_allowed.read(id_to)) {
                    return false;
                }
            }

            self.custom_rules_allow(from, to, amount)
        }

        fn transferred(
            ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) {
            self.assert_token();
            let mirror = IMirrorLookupDispatcher { contract_address: self.registry.read() };
            let id_from = mirror.identity_of(from);
            let id_to = mirror.identity_of(to);
            if id_from != 0 {
                let balance = self.id_balance.read(id_from);
                // Saturating: a forced transfer can move tokens the module was
                // never told about (it may have been wired after issuance), and
                // underflowing here would brick every later transfer.
                self
                    .id_balance
                    .write(id_from, if balance > amount {
                        balance - amount
                    } else {
                        0
                    });
            }
            if id_to != 0 {
                self.id_balance.write(id_to, self.id_balance.read(id_to) + amount);
            }
        }

        fn created(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.assert_token();
            let id_to = IMirrorLookupDispatcher { contract_address: self.registry.read() }
                .identity_of(to);
            if id_to != 0 {
                self.id_balance.write(id_to, self.id_balance.read(id_to) + amount);
            }
        }

        fn destroyed(ref self: ContractState, from: ContractAddress, amount: u256) {
            self.assert_token();
            let id_from = IMirrorLookupDispatcher { contract_address: self.registry.read() }
                .identity_of(from);
            if id_from != 0 {
                let balance = self.id_balance.read(id_from);
                self
                    .id_balance
                    .write(id_from, if balance > amount {
                        balance - amount
                    } else {
                        0
                    });
            }
        }

        fn apply_spec(ref self: ContractState, spec: ComplianceSpec) {
            self.assert_owner();

            // Clear what the previous spec set, so the result is the spec and
            // not the spec merged with history.
            let prev_allowed = self.allowed_count.read();
            let mut i: u32 = 0;
            while i != prev_allowed {
                self.country_allowed.write(self.allowed_list.read(i), false);
                i += 1;
            }
            let prev_restricted = self.restricted_count.read();
            i = 0;
            while i != prev_restricted {
                self.country_restricted.write(self.restricted_list.read(i), false);
                i += 1;
            }
            let prev_ids = self.allowed_id_count.read();
            i = 0;
            while i != prev_ids {
                self.user_allowed.write(self.allowed_id_list.read(i), false);
                i += 1;
            }

            let allowed = spec.allowed_countries;
            let allowed_len = allowed.len();
            i = 0;
            while i != allowed_len {
                let country = *allowed.at(i);
                self.country_allowed.write(country, true);
                self.allowed_list.write(i, country);
                i += 1;
            }
            self.allowed_count.write(allowed_len);
            self.country_allow_enabled.write(spec.country_allow_enabled);

            let restricted = spec.restricted_countries;
            let restricted_len = restricted.len();
            i = 0;
            while i != restricted_len {
                let country = *restricted.at(i);
                self.country_restricted.write(country, true);
                self.restricted_list.write(i, country);
                i += 1;
            }
            self.restricted_count.write(restricted_len);
            self.country_restrict_enabled.write(spec.country_restrict_enabled);

            let identities = spec.allowed_identities;
            let identities_len = identities.len();
            i = 0;
            while i != identities_len {
                let identity = *identities.at(i);
                self.user_allowed.write(identity, true);
                self.allowed_id_list.write(i, identity);
                i += 1;
            }
            self.allowed_id_count.write(identities_len);
            self.transfer_restrict_enabled.write(spec.transfer_restrict_enabled);

            self.max_balance_enabled.write(spec.max_balance_enabled);
            self.max_balance.write(spec.max_balance);
            self.supply_limit_enabled.write(spec.supply_limit_enabled);
            self.supply_limit.write(spec.supply_limit);

            self
                .emit(
                    SpecApplied {
                        country_allow_enabled: spec.country_allow_enabled,
                        allowed_country_count: allowed_len,
                        country_restrict_enabled: spec.country_restrict_enabled,
                        restricted_country_count: restricted_len,
                        max_balance_enabled: spec.max_balance_enabled,
                        max_balance: spec.max_balance,
                        supply_limit_enabled: spec.supply_limit_enabled,
                        supply_limit: spec.supply_limit,
                        transfer_restrict_enabled: spec.transfer_restrict_enabled,
                        allowed_identity_count: identities_len,
                    },
                );
        }

        fn export_spec(self: @ContractState) -> ComplianceSpec {
            let mut allowed_countries: Array<u16> = array![];
            let allowed_len = self.allowed_count.read();
            let mut i: u32 = 0;
            while i != allowed_len {
                allowed_countries.append(self.allowed_list.read(i));
                i += 1;
            }

            let mut restricted_countries: Array<u16> = array![];
            let restricted_len = self.restricted_count.read();
            i = 0;
            while i != restricted_len {
                restricted_countries.append(self.restricted_list.read(i));
                i += 1;
            }

            let mut allowed_identities: Array<felt252> = array![];
            let identities_len = self.allowed_id_count.read();
            i = 0;
            while i != identities_len {
                allowed_identities.append(self.allowed_id_list.read(i));
                i += 1;
            }

            ComplianceSpec {
                country_allow_enabled: self.country_allow_enabled.read(),
                allowed_countries,
                country_restrict_enabled: self.country_restrict_enabled.read(),
                restricted_countries,
                max_balance_enabled: self.max_balance_enabled.read(),
                max_balance: self.max_balance.read(),
                supply_limit_enabled: self.supply_limit_enabled.read(),
                supply_limit: self.supply_limit.read(),
                transfer_restrict_enabled: self.transfer_restrict_enabled.read(),
                allowed_identities,
            }
        }

        fn is_country_allowed(self: @ContractState, country: u16) -> bool {
            self.country_allowed.read(country)
        }

        fn is_country_restricted(self: @ContractState, country: u16) -> bool {
            self.country_restricted.read(country)
        }

        fn max_balance(self: @ContractState) -> u256 {
            self.max_balance.read()
        }

        fn supply_limit(self: @ContractState) -> u256 {
            self.supply_limit.read()
        }

        fn is_user_allowed(self: @ContractState, identity: felt252) -> bool {
            self.user_allowed.read(identity)
        }

        fn id_balance(self: @ContractState, identity: felt252) -> u256 {
            self.id_balance.read(identity)
        }

        fn add_rule(ref self: ContractState, rule: ContractAddress) {
            self.assert_owner();
            assert(!rule.is_zero(), 'ZERO_RULE');
            assert(self.rule_indices.read(rule) == 0, 'RULE_EXISTS');
            let count = self.rule_count.read();
            self.rules.write(count, rule);
            self.rule_indices.write(rule, count + 1);
            self.rule_count.write(count + 1);
            self.emit(RuleAdded { rule });
        }

        fn remove_rule(ref self: ContractState, rule: ContractAddress) {
            self.assert_owner();
            let sentinel = self.rule_indices.read(rule);
            assert(sentinel != 0, 'RULE_NOT_FOUND');
            let slot = sentinel - 1;
            let last = self.rule_count.read() - 1;
            if slot != last {
                let moved = self.rules.read(last);
                self.rules.write(slot, moved);
                self.rule_indices.write(moved, slot + 1);
            }
            let zero: ContractAddress = Zero::zero();
            self.rules.write(last, zero);
            self.rule_indices.write(rule, 0);
            self.rule_count.write(last);
            self.emit(RuleRemoved { rule });
        }

        fn get_rules(self: @ContractState) -> Array<ContractAddress> {
            let mut out = array![];
            let count = self.rule_count.read();
            let mut i: u32 = 0;
            while i != count {
                out.append(self.rules.read(i));
                i += 1;
            }
            out
        }

        fn set_token(ref self: ContractState, token: ContractAddress) {
            self.assert_owner();
            assert(!token.is_zero(), 'ZERO_TOKEN');
            self.token.write(token);
        }

        fn token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }

        fn registry(self: @ContractState) -> ContractAddress {
            self.registry.read()
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_owner();
            assert(!new_owner.is_zero(), 'ZERO_OWNER');
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        fn assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'ONLY_OWNER');
        }

        fn assert_token(self: @ContractState) {
            let token = self.token.read();
            assert(!token.is_zero(), 'TOKEN_UNSET');
            assert(get_caller_address() == token, 'ONLY_TOKEN');
        }

        fn custom_rules_allow(
            self: @ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            let count = self.rule_count.read();
            let mut i: u32 = 0;
            let mut ok = true;
            while i != count {
                let rule = IComplianceRuleDispatcher { contract_address: self.rules.read(i) };
                if !rule.can_transfer(from, to, amount) {
                    ok = false;
                    break;
                }
                i += 1;
            }
            ok
        }
    }
}
