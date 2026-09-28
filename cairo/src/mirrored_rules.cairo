// The Starknet-side mirror of a rule-gated ERC-20's transfer rules.
//
// A rule-gated token decides each transfer with its issuer's rules engine on
// EVM. Inside a Veil pool movements are private, so that engine cannot be
// asked; the pool applies the same rules itself, inside every proof, through
// its `ITransferRules` interface. This contract answers that interface from the
// issuer's rules as the EVM lockbox mirrors them (`IVeilRulesSource` there,
// HOLDER_RULES and TOKEN_RULES on the wire). Nothing is decided here: every
// record is a replay of what the issuer's adapter said, delivered by the
// gateway over LayerZero.
//
// It follows the mirrored registry's three disciplines:
//
//   ADDRESS GAP. Records are keyed by the EVM account the issuer's rules are
//   about. A Starknet address resolves to its EVM identity through the
//   registry's binding (an EVM wallet holding as itself is bound to itself).
//   Infrastructure the registry lists locally -- the pool, the gateway -- holds
//   without a record and is exempt from the investor-to-investor rules, as a
//   transfer agent's own wallets are on EVM.
//
//   ORDERING. Every record carries a source-assigned `seq`; an update whose seq
//   is not newer than the stored one is dropped, so out-of-order and duplicate
//   delivery are harmless.
//
//   STALENESS. Records expire after the registry's staleness window, and the
//   failure direction is always closed: a holder with no fresh rules cannot
//   hold and its notes read as fully locked; with no fresh token rules,
//   transfers are off.

use starknet::ContractAddress;

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct HolderRulesRecord {
    /// Source-assigned sequence number. 0 means "never synced".
    pub seq: u64,
    pub synced_at: u64,
    pub can_hold: bool,
    pub frozen: bool,
    pub is_investor: bool,
    pub locked: u256,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct TokenRulesRecord {
    pub seq: u64,
    pub synced_at: u64,
    pub transfers_enabled: bool,
    pub investor_cap_reached: bool,
    pub full_balance_required: bool,
    pub min_holding_strict: bool,
    pub min_holding: u256,
}

#[starknet::interface]
pub trait IVeilMirroredRules<TContractState> {
    // ── The Veil pool's `ITransferRules` ────────────────────────────────────
    fn can_hold(self: @TContractState, account: ContractAddress) -> bool;
    fn is_frozen(self: @TContractState, account: ContractAddress) -> bool;
    fn is_paused(self: @TContractState) -> bool;
    fn transfers_enabled(self: @TContractState) -> bool;
    fn can_transfer(
        self: @TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
    fn requires_full_balance(
        self: @TContractState, from: ContractAddress, to: ContractAddress,
    ) -> bool;
    fn locked_amount(self: @TContractState, account: ContractAddress) -> u256;
    fn new_investor_capped(
        self: @TContractState, from: ContractAddress, to: ContractAddress,
    ) -> bool;
    fn min_residual(
        self: @TContractState, from: ContractAddress, to: ContractAddress,
    ) -> (u256, bool);

    // ── Written only by the gateway, from inbound LayerZero messages ────────
    /// Returns false when the update is dropped as stale or out of order.
    fn apply_holder_rules(
        ref self: TContractState,
        evm_account: felt252,
        seq: u64,
        can_hold: bool,
        frozen: bool,
        is_investor: bool,
        locked: u256,
    ) -> bool;
    fn apply_token_rules(
        ref self: TContractState,
        seq: u64,
        transfers_enabled: bool,
        investor_cap_reached: bool,
        full_balance_required: bool,
        min_holding_strict: bool,
        min_holding: u256,
    ) -> bool;

    // ── Reads ───────────────────────────────────────────────────────────────
    fn holder_rules(self: @TContractState, evm_account: felt252) -> HolderRulesRecord;
    fn token_rules(self: @TContractState) -> TokenRulesRecord;
    fn registry(self: @TContractState) -> ContractAddress;
    fn gateway(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;

    // ── Admin ───────────────────────────────────────────────────────────────
    fn set_gateway(ref self: TContractState, gateway: ContractAddress);
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

#[starknet::contract]
pub mod VeilMirroredRules {
    use core::num::traits::{Bounded, Zero};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::super::mirrored_registry::{
        IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
    };
    use super::{HolderRulesRecord, IVeilMirroredRules, TokenRulesRecord};

    /// No locked amount or investor flag: they describe a holder's position,
    /// and indexed by account they would be a free log filter over it.
    #[derive(Drop, starknet::Event)]
    pub struct HolderRulesApplied {
        #[key]
        pub evm_account: felt252,
        pub seq: u64,
        pub can_hold: bool,
        pub frozen: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TokenRulesApplied {
        pub seq: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RulesDropped {
        #[key]
        pub evm_account: felt252,
        pub incoming_seq: u64,
        pub stored_seq: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct GatewaySet {
        #[key]
        pub gateway: ContractAddress,
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
        HolderRulesApplied: HolderRulesApplied,
        TokenRulesApplied: TokenRulesApplied,
        RulesDropped: RulesDropped,
        GatewaySet: GatewaySet,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        gateway: ContractAddress,
        /// The asset's mirrored registry: the binding from a Starknet address
        /// to its EVM identity, the infrastructure list, the pause and the
        /// staleness window all come from it, so the two mirrors never disagree.
        registry: ContractAddress,
        holders: Map<felt252, HolderRulesRecord>,
        token: TokenRulesRecord,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, registry: ContractAddress) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        assert(!registry.is_zero(), 'ZERO_REGISTRY');
        self.owner.write(owner);
        self.registry.write(registry);
    }

    #[abi(embed_v0)]
    impl VeilMirroredRulesImpl of IVeilMirroredRules<ContractState> {
        fn can_hold(self: @ContractState, account: ContractAddress) -> bool {
            if self.is_local(account) {
                return true;
            }
            match self.fresh_holder(account) {
                Option::Some(r) => r.can_hold && !r.frozen,
                Option::None => false,
            }
        }

        fn is_frozen(self: @ContractState, account: ContractAddress) -> bool {
            if self.is_local(account) {
                return false;
            }
            let evm_account = self.registry_dispatcher().identity_of(account);
            if evm_account == 0 {
                return false;
            }
            // A freeze does not expire: the last word from the issuer stands.
            self.holders.read(evm_account).frozen
        }

        fn is_paused(self: @ContractState) -> bool {
            self.registry_dispatcher().global_paused()
        }

        fn transfers_enabled(self: @ContractState) -> bool {
            match self.fresh_token() {
                Option::Some(t) => t.transfers_enabled,
                Option::None => false,
            }
        }

        fn can_transfer(
            self: @ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            if self.is_paused() || self.is_frozen(from) || self.is_frozen(to) {
                return false;
            }
            if !self.can_hold(to) {
                return false;
            }
            // Holder-to-holder movements need the issuer's transfer switch on;
            // a movement to or from infrastructure (the pool paying the bridge
            // on an exit) is not one.
            if self.is_local(from) || self.is_local(to) {
                return true;
            }
            self.transfers_enabled()
        }

        fn requires_full_balance(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> bool {
            if self.is_local(from) || self.is_local(to) {
                return false;
            }
            match self.fresh_token() {
                Option::Some(t) => t.full_balance_required,
                // Unreachable in practice -- stale token rules switch transfers
                // off -- and closed anyway.
                Option::None => true,
            }
        }

        fn locked_amount(self: @ContractState, account: ContractAddress) -> u256 {
            if self.is_local(account) {
                return 0;
            }
            match self.fresh_holder(account) {
                Option::Some(r) => r.locked,
                // No fresh word from the issuer: everything reads as locked.
                Option::None => Bounded::MAX,
            }
        }

        fn new_investor_capped(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> bool {
            if self.is_local(from) || self.is_local(to) {
                return false;
            }
            let cap_reached = match self.fresh_token() {
                Option::Some(t) => t.investor_cap_reached,
                Option::None => true,
            };
            if !cap_reached {
                return false;
            }
            match self.fresh_holder(to) {
                Option::Some(r) => !r.is_investor,
                Option::None => true,
            }
        }

        fn min_residual(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> (u256, bool) {
            if self.is_local(from) || self.is_local(to) {
                return (0, false);
            }
            match self.fresh_token() {
                Option::Some(t) => (t.min_holding, t.min_holding_strict),
                Option::None => (Bounded::MAX, true),
            }
        }

        fn apply_holder_rules(
            ref self: ContractState,
            evm_account: felt252,
            seq: u64,
            can_hold: bool,
            frozen: bool,
            is_investor: bool,
            locked: u256,
        ) -> bool {
            self.assert_gateway();
            assert(evm_account != 0, 'ZERO_EVM_ACCOUNT');
            assert(seq != 0, 'ZERO_SEQ');
            let stored = self.holders.read(evm_account);
            if seq <= stored.seq {
                self.emit(RulesDropped { evm_account, incoming_seq: seq, stored_seq: stored.seq });
                return false;
            }
            self
                .holders
                .write(
                    evm_account,
                    HolderRulesRecord {
                        seq, synced_at: get_block_timestamp(), can_hold, frozen, is_investor, locked,
                    },
                );
            self.emit(HolderRulesApplied { evm_account, seq, can_hold, frozen });
            true
        }

        fn apply_token_rules(
            ref self: ContractState,
            seq: u64,
            transfers_enabled: bool,
            investor_cap_reached: bool,
            full_balance_required: bool,
            min_holding_strict: bool,
            min_holding: u256,
        ) -> bool {
            self.assert_gateway();
            assert(seq != 0, 'ZERO_SEQ');
            let stored = self.token.read();
            if seq <= stored.seq {
                self.emit(RulesDropped { evm_account: 0, incoming_seq: seq, stored_seq: stored.seq });
                return false;
            }
            self
                .token
                .write(
                    TokenRulesRecord {
                        seq,
                        synced_at: get_block_timestamp(),
                        transfers_enabled,
                        investor_cap_reached,
                        full_balance_required,
                        min_holding_strict,
                        min_holding,
                    },
                );
            self.emit(TokenRulesApplied { seq });
            true
        }

        fn holder_rules(self: @ContractState, evm_account: felt252) -> HolderRulesRecord {
            self.holders.read(evm_account)
        }

        fn token_rules(self: @ContractState) -> TokenRulesRecord {
            self.token.read()
        }

        fn registry(self: @ContractState) -> ContractAddress {
            self.registry.read()
        }

        fn gateway(self: @ContractState) -> ContractAddress {
            self.gateway.read()
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn set_gateway(ref self: ContractState, gateway: ContractAddress) {
            self.assert_owner();
            assert(!gateway.is_zero(), 'ZERO_GATEWAY');
            self.gateway.write(gateway);
            self.emit(GatewaySet { gateway });
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

        fn assert_gateway(self: @ContractState) {
            let gateway = self.gateway.read();
            assert(!gateway.is_zero(), 'GATEWAY_UNSET');
            assert(get_caller_address() == gateway, 'ONLY_GATEWAY');
        }

        fn registry_dispatcher(self: @ContractState) -> IVeilMirroredRegistryDispatcher {
            IVeilMirroredRegistryDispatcher { contract_address: self.registry.read() }
        }

        fn is_local(self: @ContractState, account: ContractAddress) -> bool {
            self.registry_dispatcher().local_identity(account).allowed
        }

        fn is_fresh(self: @ContractState, synced_at: u64) -> bool {
            let window = self.registry_dispatcher().staleness_window();
            window == 0 || get_block_timestamp() <= synced_at + window
        }

        /// The holder's rules, when the issuer's last word on them is fresh.
        fn fresh_holder(self: @ContractState, account: ContractAddress) -> Option<HolderRulesRecord> {
            let evm_account = self.registry_dispatcher().identity_of(account);
            if evm_account == 0 {
                return Option::None;
            }
            let r = self.holders.read(evm_account);
            if r.seq == 0 || !self.is_fresh(r.synced_at) {
                return Option::None;
            }
            Option::Some(r)
        }

        fn fresh_token(self: @ContractState) -> Option<TokenRulesRecord> {
            let t = self.token.read();
            if t.seq == 0 || !self.is_fresh(t.synced_at) {
                return Option::None;
            }
            Option::Some(t)
        }
    }
}
