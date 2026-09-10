// The Starknet-side mirror of an EVM ERC-3643 identity registry.
//
// It exposes exactly the `is_verified` / `investor_country` surface the Veil
// pool and the ERC-3643 token already call, so a bridged asset drops into the
// existing pool machinery with no changes on that side. What differs is where
// the answers come from: nothing here is decided locally, every record is a
// replay of a decision the source-chain registry already made, delivered by the
// gateway over LayerZero.
//
// Three problems that a naive "copy the flags across" mirror gets wrong, and
// what this contract does about each:
//
//   ADDRESS GAP. The EVM registry knows an EVM address; the holder on Starknet
//   is a different address entirely. Records are therefore keyed by the EVM
//   account — the thing compliance is actually *about* — and a separate binding
//   maps each Starknet address to the EVM identity backing it. One EVM identity
//   may back several Starknet wallets, and revoking it revokes all of them in
//   one write, with no iteration. A Starknet address, once bound, cannot be
//   re-bound by an inbound message: otherwise a revoked holder could point
//   their wallet at a fresh identity. Only `admin_rebind` moves it, which is
//   the same recovery power T-REX already grants agents.
//
//   STALENESS. Eligibility can be withdrawn on the source chain at any moment
//   and the mirror only knows what was last pushed. So records expire: past
//   `staleness_window` seconds `is_verified` returns false and the asset stops
//   moving until someone refreshes it. Refreshing is permissionless — the
//   lockbox's `syncCompliance` only re-reads the live registry, so the caller
//   cannot assert anything the source does not already say. That window is the
//   one behavioral difference from checking the registry in-line, and it is the
//   number to quote to an issuer.
//
//   ORDERING. LayerZero does not guarantee ordered delivery unless the OApp
//   opts in, so a stale "verified" could otherwise land after a fresh "revoked"
//   and silently re-enable an account. Every record carries a source-assigned
//   monotonic `seq` and updates with `seq <= stored` are dropped, which makes
//   out-of-order and duplicate delivery harmless rather than dangerous.
//
// Failure direction is always closed: unknown account, unbound wallet, never
// synced, stale, frozen, or globally paused all read as "not verified".

use starknet::ContractAddress;

/// An address registered HERE rather than mirrored from the source chain.
///
/// Every mirrored record describes an investor with an EVM counterpart. A Veil
/// pool is a Starknet contract with none, so it can never satisfy the binding
/// and could never receive the twin -- which would make the bridged asset
/// unusable in Veil, the reason for bridging it. The pool is therefore
/// registered directly, exactly as a T-REX agent registers a pool in an
/// identity registry on its own chain.
///
/// Deliberately NOT subject to the staleness window: there is no source record
/// to go stale. Borrowing an investor's binding instead (via `admin_rebind`)
/// would look like it works and then start failing when that record expired.
#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct LocalIdentity {
    pub allowed: bool,
    pub country: u16,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct IdentityRecord {
    /// Source-assigned sequence number. 0 means "never synced".
    pub seq: u64,
    /// Block timestamp at which this record was applied here.
    pub synced_at: u64,
    pub verified: bool,
    pub frozen: bool,
    pub country: u16,
}

#[starknet::interface]
pub trait IVeilMirroredRegistry<TContractState> {
    // ── T-REX registry surface: what the token and the Veil pool call ───────
    fn is_verified(self: @TContractState, account: ContractAddress) -> bool;
    fn investor_country(self: @TContractState, account: ContractAddress) -> u16;

    // ── Written only by the gateway, from inbound LayerZero messages ────────
    /// Returns false when the update is dropped as stale or out of order.
    fn apply_identity(
        ref self: TContractState,
        evm_account: felt252,
        seq: u64,
        verified: bool,
        frozen: bool,
        country: u16,
    ) -> bool;
    /// Binds a Starknet wallet to the EVM identity backing it. Returns false if
    /// the wallet is already bound to a different identity, which the gateway
    /// treats as a policy conflict (quarantine) rather than a protocol error.
    fn bind(ref self: TContractState, sn_account: ContractAddress, evm_account: felt252) -> bool;
    fn apply_global(ref self: TContractState, seq: u64, paused: bool) -> bool;

    // ── Reads ───────────────────────────────────────────────────────────────
    fn identity_of(self: @TContractState, sn_account: ContractAddress) -> felt252;
    fn record(self: @TContractState, evm_account: felt252) -> IdentityRecord;
    fn is_fresh(self: @TContractState, evm_account: felt252) -> bool;
    fn staleness_window(self: @TContractState) -> u64;
    fn global_paused(self: @TContractState) -> bool;
    fn global_seq(self: @TContractState) -> u64;
    fn gateway(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;

    // ── Admin ───────────────────────────────────────────────────────────────
    fn set_gateway(ref self: TContractState, gateway: ContractAddress);
    fn set_staleness_window(ref self: TContractState, window: u64);
    /// Recovery lever for a wallet bound to the wrong identity. Mirrors the
    /// agent recovery powers ERC-3643 already defines.
    fn admin_rebind(ref self: TContractState, sn_account: ContractAddress, evm_account: felt252);
    /// Register (or revoke) a Starknet address that holds the twin as
    /// infrastructure rather than as an investor. Owner-gated, and the owner
    /// already controls this deployment, so it grants no new authority -- but
    /// it IS a declaration that an address may hold, so register contracts you
    /// have reason to trust, not arbitrary addresses.
    fn set_local_identity(
        ref self: TContractState, sn_account: ContractAddress, allowed: bool, country: u16,
    );
    fn local_identity(self: @TContractState, sn_account: ContractAddress) -> LocalIdentity;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

#[starknet::contract]
pub mod VeilMirroredRegistry {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::{IVeilMirroredRegistry, IdentityRecord, LocalIdentity};

    /// `evm_account` stays: without it an operator cannot tell WHICH record
    /// moved, and the event is useless. `country` does not -- it is a KYC
    /// attribute that nothing reads, and emitting it indexed by identity would
    /// hand anyone "every identity from country X" as a log filter. The
    /// compliance module reads `investor_country()` from storage, which only
    /// answers for an address you already hold. Do not add it back.
    #[derive(Drop, starknet::Event)]
    pub struct IdentityApplied {
        #[key]
        pub evm_account: felt252,
        pub seq: u64,
        pub verified: bool,
        pub frozen: bool,
    }

    /// Emitted instead of reverting when an update arrives out of order, so the
    /// drop is visible to an operator watching the mirror.
    #[derive(Drop, starknet::Event)]
    pub struct IdentityDropped {
        #[key]
        pub evm_account: felt252,
        pub incoming_seq: u64,
        pub stored_seq: u64,
    }

    #[derive(Drop, starknet::Event)]
    /// The pairing itself is not published. It is derivable by anyone who
    /// enumerates recipients from the twin's ERC-20 transfers and then calls
    /// `identity_of` per address -- so this is a cost increase, not a secret --
    /// but there is no reason to serve it up as an indexed log.
    pub struct WalletBound {
        #[key]
        pub sn_account: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BindingConflict {
        #[key]
        pub sn_account: ContractAddress,
    }

    /// Carries no country: it is a KYC-shaped attribute and nothing reads it
    /// back from the log, same rule as everywhere else here.
    #[derive(Drop, starknet::Event)]
    pub struct LocalIdentitySet {
        #[key]
        pub sn_account: ContractAddress,
        pub allowed: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct GlobalApplied {
        pub seq: u64,
        pub paused: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct StalenessWindowSet {
        pub window: u64,
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
        IdentityApplied: IdentityApplied,
        IdentityDropped: IdentityDropped,
        WalletBound: WalletBound,
        BindingConflict: BindingConflict,
        LocalIdentitySet: LocalIdentitySet,
        GlobalApplied: GlobalApplied,
        StalenessWindowSet: StalenessWindowSet,
        GatewaySet: GatewaySet,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        gateway: ContractAddress,
        /// EVM account -> last replayed decision about it.
        identities: Map<felt252, IdentityRecord>,
        /// Starknet wallet -> the EVM identity that backs it. 0 = unbound.
        bindings: Map<ContractAddress, felt252>,
        /// Contracts registered here rather than mirrored. Checked before the
        /// binding, so infrastructure never depends on an investor's record.
        local_identities: Map<ContractAddress, LocalIdentity>,
        /// Seconds a record stays usable. 0 disables expiry, which is only
        /// appropriate on a devnet: on a live deployment an unbounded window
        /// means an unbounded revocation lag.
        staleness_window: u64,
        global_seq: u64,
        global_paused: bool,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, staleness_window: u64) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        self.owner.write(owner);
        self.staleness_window.write(staleness_window);
    }

    #[abi(embed_v0)]
    impl VeilMirroredRegistryImpl of IVeilMirroredRegistry<ContractState> {
        fn is_verified(self: @ContractState, account: ContractAddress) -> bool {
            // A global pause stops everything, infrastructure included.
            if self.global_paused.read() {
                return false;
            }
            // Locally registered infrastructure short-circuits the binding: it
            // has no source record, so there is nothing to look up or expire.
            if self.local_identities.read(account).allowed {
                return true;
            }
            let evm_account = self.bindings.read(account);
            if evm_account == 0 {
                return false;
            }
            let record = self.identities.read(evm_account);
            if record.seq == 0 || !record.verified || record.frozen {
                return false;
            }
            self.record_is_fresh(record)
        }

        fn investor_country(self: @ContractState, account: ContractAddress) -> u16 {
            let local = self.local_identities.read(account);
            if local.allowed {
                return local.country;
            }
            let evm_account = self.bindings.read(account);
            if evm_account == 0 {
                return 0;
            }
            self.identities.read(evm_account).country
        }

        fn apply_identity(
            ref self: ContractState,
            evm_account: felt252,
            seq: u64,
            verified: bool,
            frozen: bool,
            country: u16,
        ) -> bool {
            self.assert_gateway();
            assert(evm_account != 0, 'ZERO_EVM_ACCOUNT');
            assert(seq != 0, 'ZERO_SEQ');

            let stored = self.identities.read(evm_account);
            // Strictly increasing: equal sequence numbers are duplicate
            // deliveries of a decision already applied.
            if seq <= stored.seq {
                self.emit(IdentityDropped { evm_account, incoming_seq: seq, stored_seq: stored.seq });
                return false;
            }

            self
                .identities
                .write(
                    evm_account,
                    IdentityRecord {
                        seq, synced_at: get_block_timestamp(), verified, frozen, country,
                    },
                );
            self.emit(IdentityApplied { evm_account, seq, verified, frozen });
            true
        }

        fn bind(
            ref self: ContractState, sn_account: ContractAddress, evm_account: felt252,
        ) -> bool {
            self.assert_gateway();
            assert(!sn_account.is_zero(), 'ZERO_SN_ACCOUNT');
            assert(evm_account != 0, 'ZERO_EVM_ACCOUNT');

            let existing = self.bindings.read(sn_account);
            if existing == evm_account {
                return true;
            }
            if existing != 0 {
                // Re-pointing a bound wallet is how a revoked holder would try
                // to launder eligibility, so inbound messages never do it.
                self.emit(BindingConflict { sn_account });
                return false;
            }

            self.bindings.write(sn_account, evm_account);
            self.emit(WalletBound { sn_account });
            true
        }

        fn apply_global(ref self: ContractState, seq: u64, paused: bool) -> bool {
            self.assert_gateway();
            assert(seq != 0, 'ZERO_SEQ');
            let stored = self.global_seq.read();
            if seq <= stored {
                return false;
            }
            self.global_seq.write(seq);
            self.global_paused.write(paused);
            self.emit(GlobalApplied { seq, paused });
            true
        }

        fn identity_of(self: @ContractState, sn_account: ContractAddress) -> felt252 {
            self.bindings.read(sn_account)
        }

        fn record(self: @ContractState, evm_account: felt252) -> IdentityRecord {
            self.identities.read(evm_account)
        }

        fn is_fresh(self: @ContractState, evm_account: felt252) -> bool {
            let record = self.identities.read(evm_account);
            if record.seq == 0 {
                return false;
            }
            self.record_is_fresh(record)
        }

        fn staleness_window(self: @ContractState) -> u64 {
            self.staleness_window.read()
        }

        fn global_paused(self: @ContractState) -> bool {
            self.global_paused.read()
        }

        fn global_seq(self: @ContractState) -> u64 {
            self.global_seq.read()
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

        fn set_staleness_window(ref self: ContractState, window: u64) {
            self.assert_owner();
            self.staleness_window.write(window);
            self.emit(StalenessWindowSet { window });
        }

        fn admin_rebind(
            ref self: ContractState, sn_account: ContractAddress, evm_account: felt252,
        ) {
            self.assert_owner();
            assert(!sn_account.is_zero(), 'ZERO_SN_ACCOUNT');
            self.bindings.write(sn_account, evm_account);
            self.emit(WalletBound { sn_account });
        }

        fn set_local_identity(
            ref self: ContractState, sn_account: ContractAddress, allowed: bool, country: u16,
        ) {
            self.assert_owner();
            assert(!sn_account.is_zero(), 'ZERO_SN_ACCOUNT');
            self.local_identities.write(sn_account, LocalIdentity { allowed, country });
            self.emit(LocalIdentitySet { sn_account, allowed });
        }

        fn local_identity(self: @ContractState, sn_account: ContractAddress) -> LocalIdentity {
            self.local_identities.read(sn_account)
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

        fn record_is_fresh(self: @ContractState, record: IdentityRecord) -> bool {
            let window = self.staleness_window.read();
            if window == 0 {
                return true;
            }
            get_block_timestamp() <= record.synced_at + window
        }
    }
}
