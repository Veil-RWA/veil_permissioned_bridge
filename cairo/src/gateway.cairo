// The Starknet end of the bridge: a LayerZero V2 OApp.
//
// Inbound it turns messages from the EVM lockbox into mirrored compliance state
// and minted supply. Outbound it burns and instructs the lockbox to release.
//
// The peer check and endpoint gate here are the same two assertions
// `OAppCoreComponent::lz_receive` makes before delegating to `_lz_receive`;
// they are inlined rather than inherited so the contract carries no dependency
// on a package pinned to an older toolchain (see `bytes.cairo`). The external
// ABI is identical, so the deployed endpoint drives this contract unmodified.
//
// One rule governs every inbound path: NEVER REVERT ON A POLICY OUTCOME.
// By the time a MINT arrives the tokens are already escrowed on Ethereum, and a
// reverting `lz_receive` leaves the message in the endpoint's retry queue with
// the escrow stranded behind it. So an ineligible recipient is quarantined in
// `pending` and claimable later, not rejected. Protocol errors — an unknown
// message kind, a truncated payload, a malformed address — do revert, because
// those are bugs and a stuck retryable message is the right way to surface one.
//
// Replay is the endpoint's job: it executes each (src_eid, sender, nonce) at
// most once, so this contract keeps no nonce bookkeeping of its own. Ordering
// is not the endpoint's job in unordered mode, which is why every compliance
// record carries its own `seq` and the mirror drops anything out of date.

use starknet::ContractAddress;
use super::lz::{Bytes32, MessagingFee};

#[starknet::interface]
pub trait IVeilBridgeGateway<TContractState> {
    // ── Outbound ────────────────────────────────────────────────────────────
    /// Burns `amount` from the caller and asks the lockbox to release the same
    /// amount to `evm_recipient`. The caller must first approve this contract
    /// for `fee.native_fee` of the native token, which is how LayerZero's own
    /// Starknet OApps collect fees (the endpoint is paid by this contract, not
    /// by the caller directly).
    fn bridge_back(
        ref self: TContractState,
        amount: u256,
        evm_recipient: felt252,
        fee: MessagingFee,
        gas_limit: u128,
        refund_address: ContractAddress,
    );
    fn quote_bridge_back(
        self: @TContractState, amount: u256, evm_recipient: felt252, gas_limit: u128,
    ) -> MessagingFee;

    // ── Quarantine ──────────────────────────────────────────────────────────
    /// Mints tokens held back because the recipient was not eligible when the
    /// bridge-in landed. Permissionless: the funds only ever move to the
    /// recipient, so anyone may pay the gas to release them once compliance
    /// data allows it.
    fn claim_pending(ref self: TContractState, recipient: ContractAddress);
    fn pending_of(self: @TContractState, recipient: ContractAddress) -> u256;
    fn total_pending(self: @TContractState) -> u256;

    // ── Wiring ──────────────────────────────────────────────────────────────
    fn set_peer(ref self: TContractState, eid: u32, peer: Bytes32);
    fn get_peer(self: @TContractState, eid: u32) -> Bytes32;
    fn set_delegate(ref self: TContractState, delegate: ContractAddress);
    fn set_dst_eid(ref self: TContractState, dst_eid: u32);
    fn set_token(ref self: TContractState, token: ContractAddress);
    /// The DEFAULT Veil pool, used by every POOL message that names none.
    /// Zero disables default pool delivery, and those messages then land in the
    /// recipient's wallet.
    fn set_pool(ref self: TContractState, pool: ContractAddress);
    fn pool(self: @TContractState) -> ContractAddress;
    /// The VeilERC3643Factory that vouches for any OTHER pool a message names.
    /// Zero means only the default pool is reachable.
    fn set_factory(ref self: TContractState, factory: ContractAddress);
    fn factory(self: @TContractState) -> ContractAddress;
    /// Claim an open note for pool delivery. The caller becomes its owner here,
    /// and only a transfer addressed to that same owner may fill it.
    fn register_note(ref self: TContractState, note_id: felt252);
    fn note_owner(self: @TContractState, note_id: felt252) -> ContractAddress;
    fn dst_eid(self: @TContractState) -> u32;
    fn token(self: @TContractState) -> ContractAddress;
    fn registry(self: @TContractState) -> ContractAddress;
    fn get_endpoint(self: @TContractState) -> ContractAddress;
    fn native_token(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

#[starknet::contract]
pub mod VeilBridgeGateway {
    use core::num::traits::Zero;
    use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::super::bridged_token::{
        IVeilBridgedERC3643Dispatcher, IVeilBridgedERC3643DispatcherTrait,
    };
    use super::super::lz::{
        Bytes32, ContractAddressIntoBytes32, IEndpointV2Dispatcher, IEndpointV2DispatcherTrait,
        ILayerZeroReceiver, MessagingFee, MessagingParams, Origin, build_lz_receive_options,
    };
    use super::super::mirrored_registry::{
        IVeilMirroredRegistryDispatcher, IVeilMirroredRegistryDispatcherTrait,
    };
    use super::super::msg_codec::{
        DELIVERY_POOL, KIND_GLOBAL, KIND_IDENTITY, KIND_MINT, decode_global, decode_identity,
        decode_mint, encode_unlock, kind,
    };
    // Both the pool and the factory are called through caught syscalls rather
    // than dispatchers: a third-party contract that reverts must not take an
    // inbound message down with it. See `deliver_to_pool` and `resolve_pool`.
    use super::IVeilBridgeGateway;

    /// Deliberately carries no source identity. A Map cannot be enumerated, so
    /// storage only answers questions about an address you already have --
    /// events are the one surface that can be scraped wholesale, and an indexed
    /// `evm_sender` would hand anyone "every bridge-in from this EVM address"
    /// for free. Nothing reads it; the message `guid` already ties a mint to
    /// its origin for anyone debugging. Do not add it back.
    #[derive(Drop, starknet::Event)]
    pub struct BridgeInMinted {
        #[key]
        pub recipient: ContractAddress,
        pub amount: u256,
    }

    /// The recipient was not eligible when their tokens arrived. Nothing is
    /// lost; `claim_pending` releases them once the mirror says otherwise.
    #[derive(Drop, starknet::Event)]
    pub struct BridgeInQuarantined {
        #[key]
        pub recipient: ContractAddress,
        pub amount: u256,
        pub reason: felt252,
    }

    /// Filled into a pool note rather than a public wallet.
    #[derive(Drop, starknet::Event)]
    pub struct DeliveredToPool {
        #[key]
        pub recipient: ContractAddress,
        #[key]
        pub note_id: felt252,
        pub amount: u256,
    }

    /// Pool delivery was asked for and did not happen, so the amount went to
    /// the recipient's wallet. Never a loss; always worth alerting on.
    #[derive(Drop, starknet::Event)]
    pub struct DeliveryFellBack {
        #[key]
        pub recipient: ContractAddress,
        pub amount: u256,
        pub reason: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct NoteRegistered {
        #[key]
        pub note_id: felt252,
        #[key]
        pub owner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PendingClaimed {
        #[key]
        pub recipient: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    /// No destination identity, for the same reason `BridgeInMinted` carries no
    /// source: an indexed pair is a free cross-chain linkage query. `from` stays
    /// because it is the transaction's own sender and public regardless. The
    /// destination is in the outgoing message; it does not need a log filter too.
    pub struct BridgeBackSent {
        #[key]
        pub from: ContractAddress,
        pub amount: u256,
        pub nonce: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PeerSet {
        #[key]
        pub eid: u32,
        pub peer: Bytes32,
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
        BridgeInMinted: BridgeInMinted,
        BridgeInQuarantined: BridgeInQuarantined,
        DeliveredToPool: DeliveredToPool,
        DeliveryFellBack: DeliveryFellBack,
        NoteRegistered: NoteRegistered,
        PendingClaimed: PendingClaimed,
        BridgeBackSent: BridgeBackSent,
        PeerSet: PeerSet,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        endpoint: ContractAddress,
        /// Fee token the endpoint charges in (STRK on both Starknet networks).
        native_token: ContractAddress,
        peers: Map<u32, Bytes32>,
        token: ContractAddress,
        registry: ContractAddress,
        pool: ContractAddress,
        /// Vouches for a pool the message names instead of the default one.
        factory: ContractAddress,
        /// note_id -> the address allowed to have it filled. Claimed by the
        /// holder, write-once, so a claim cannot be taken over later.
        note_owners: Map<felt252, ContractAddress>,
        /// Endpoint id of the chain holding the lockbox (Ethereum: 30101
        /// mainnet, 40161 Sepolia).
        dst_eid: u32,
        pending: Map<ContractAddress, u256>,
        total_pending: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        endpoint: ContractAddress,
        native_token: ContractAddress,
        registry: ContractAddress,
        dst_eid: u32,
    ) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        assert(!endpoint.is_zero(), 'ZERO_ENDPOINT');
        assert(!registry.is_zero(), 'ZERO_REGISTRY');
        self.owner.write(owner);
        self.endpoint.write(endpoint);
        self.native_token.write(native_token);
        self.registry.write(registry);
        self.dst_eid.write(dst_eid);
    }

    // ── LayerZero receiver ──────────────────────────────────────────────────
    #[abi(embed_v0)]
    impl LayerZeroReceiverImpl of ILayerZeroReceiver<ContractState> {
        fn lz_receive(
            ref self: ContractState,
            origin: Origin,
            guid: Bytes32,
            message: ByteArray,
            executor: ContractAddress,
            extra_data: ByteArray,
            value: u256,
        ) {
            assert(get_caller_address() == self.endpoint.read(), 'ONLY_ENDPOINT');
            let expected = self.peers.read(origin.src_eid);
            assert(expected.value != 0, 'NO_PEER');
            assert(expected == origin.sender, 'ONLY_PEER');

            let message_kind = kind(@message);
            if message_kind == KIND_MINT {
                self.handle_mint(@message);
            } else if message_kind == KIND_IDENTITY {
                let snapshot = decode_identity(@message);
                self
                    .registry_dispatcher()
                    .apply_identity(
                        snapshot.evm_account,
                        snapshot.seq,
                        snapshot.verified,
                        snapshot.frozen,
                        snapshot.country,
                    );
            } else if message_kind == KIND_GLOBAL {
                let params = decode_global(@message);
                self.registry_dispatcher().apply_global(params.seq, params.paused);
            } else {
                // A kind we do not understand can only come from a peer we
                // configured, so it is a wiring or version bug. Revert and let
                // the endpoint hold the message for retry after a fix.
                panic!("BRIDGE_UNKNOWN_KIND");
            }
        }

        fn allow_initialize_path(self: @ContractState, origin: Origin) -> bool {
            let peer = self.peers.read(origin.src_eid);
            peer.value != 0 && peer == origin.sender
        }

        /// 0 = unordered delivery. Ordering across compliance updates is
        /// enforced by the per-record `seq` in the mirror, which also survives
        /// duplicate and delayed delivery; enforcing it here as well would
        /// block the channel on any single stuck message.
        fn next_nonce(self: @ContractState, src_eid: u32, sender: Bytes32) -> u64 {
            0
        }
    }

    #[abi(embed_v0)]
    impl VeilBridgeGatewayImpl of IVeilBridgeGateway<ContractState> {
        fn bridge_back(
            ref self: ContractState,
            amount: u256,
            evm_recipient: felt252,
            fee: MessagingFee,
            gas_limit: u128,
            refund_address: ContractAddress,
        ) {
            assert(amount != 0, 'ZERO_AMOUNT');
            let caller = get_caller_address();
            let dst_eid = self.dst_eid.read();

            // Burn first: the token runs the full ERC-3643 gate on the holder,
            // so an ineligible caller reverts here before any fee is taken.
            self.token_dispatcher().bridge_burn(caller, amount);

            let message = encode_unlock(evm_recipient, amount);
            let options = build_lz_receive_options(gas_limit);
            let receipt = self.lz_send(caller, dst_eid, message, options, fee, refund_address);

            self.emit(BridgeBackSent { from: caller, amount, nonce: receipt.nonce });
        }

        fn quote_bridge_back(
            self: @ContractState, amount: u256, evm_recipient: felt252, gas_limit: u128,
        ) -> MessagingFee {
            let dst_eid = self.dst_eid.read();
            let params = MessagingParams {
                dst_eid,
                receiver: self.peer_or_revert(dst_eid),
                message: encode_unlock(evm_recipient, amount),
                options: build_lz_receive_options(gas_limit),
                pay_in_lz_token: false,
            };
            IEndpointV2Dispatcher { contract_address: self.endpoint.read() }
                .quote(params, get_contract_address())
        }

        fn claim_pending(ref self: ContractState, recipient: ContractAddress) {
            let amount = self.pending.read(recipient);
            assert(amount != 0, 'NOTHING_PENDING');
            let token = self.token_dispatcher();
            assert(token.can_bridge_mint(recipient, amount), 'STILL_INELIGIBLE');

            // Clear before minting: `bridge_mint` calls out to the token, and
            // zeroing first means a re-entrant claim finds nothing to release.
            self.pending.write(recipient, 0);
            self.total_pending.write(self.total_pending.read() - amount);
            token.bridge_mint(recipient, amount);
            self.emit(PendingClaimed { recipient, amount });
        }

        fn pending_of(self: @ContractState, recipient: ContractAddress) -> u256 {
            self.pending.read(recipient)
        }

        fn total_pending(self: @ContractState) -> u256 {
            self.total_pending.read()
        }

        fn set_peer(ref self: ContractState, eid: u32, peer: Bytes32) {
            self.assert_owner();
            self.peers.write(eid, peer);
            self.emit(PeerSet { eid, peer });
        }

        fn get_peer(self: @ContractState, eid: u32) -> Bytes32 {
            self.peers.read(eid)
        }

        fn set_delegate(ref self: ContractState, delegate: ContractAddress) {
            self.assert_owner();
            IEndpointV2Dispatcher { contract_address: self.endpoint.read() }
                .set_delegate(delegate);
        }

        fn set_dst_eid(ref self: ContractState, dst_eid: u32) {
            self.assert_owner();
            self.dst_eid.write(dst_eid);
        }

        fn set_token(ref self: ContractState, token: ContractAddress) {
            self.assert_owner();
            assert(!token.is_zero(), 'ZERO_TOKEN');
            self.token.write(token);
        }

        fn dst_eid(self: @ContractState) -> u32 {
            self.dst_eid.read()
        }

        fn set_pool(ref self: ContractState, pool: ContractAddress) {
            self.assert_owner();
            self.pool.write(pool);
        }

        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }

        fn set_factory(ref self: ContractState, factory: ContractAddress) {
            self.assert_owner();
            self.factory.write(factory);
        }

        fn factory(self: @ContractState) -> ContractAddress {
            self.factory.read()
        }

        /// Claim a note before bridging into it.
        ///
        /// The pool cannot tell the gateway who owns a note -- `get_open_note`
        /// returns only its token -- and note ids are public. Without a claim,
        /// any sender could name any note in a message and have it filled with
        /// dust; the fill is one-shot, so that note could never receive its real
        /// proceeds. Requiring the recipient to claim it first means an attacker
        /// must both win the race to claim and address the transfer to himself.
        ///
        /// Write-once: a claim cannot be reassigned, so nobody can take over a
        /// note someone else already holds.
        fn register_note(ref self: ContractState, note_id: felt252) {
            assert(note_id != 0, 'ZERO_NOTE_ID');
            let caller = get_caller_address();
            let existing = self.note_owners.read(note_id);
            assert(existing.is_zero() || existing == caller, 'NOTE_ALREADY_CLAIMED');
            self.note_owners.write(note_id, caller);
            self.emit(NoteRegistered { note_id, owner: caller });
        }

        fn note_owner(self: @ContractState, note_id: felt252) -> ContractAddress {
            self.note_owners.read(note_id)
        }

        fn token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }

        fn registry(self: @ContractState) -> ContractAddress {
            self.registry.read()
        }

        fn get_endpoint(self: @ContractState) -> ContractAddress {
            self.endpoint.read()
        }

        fn native_token(self: @ContractState) -> ContractAddress {
            self.native_token.read()
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

        fn token_dispatcher(self: @ContractState) -> IVeilBridgedERC3643Dispatcher {
            let token = self.token.read();
            assert(!token.is_zero(), 'TOKEN_UNSET');
            IVeilBridgedERC3643Dispatcher { contract_address: token }
        }

        fn registry_dispatcher(self: @ContractState) -> IVeilMirroredRegistryDispatcher {
            IVeilMirroredRegistryDispatcher { contract_address: self.registry.read() }
        }

        fn peer_or_revert(self: @ContractState, eid: u32) -> Bytes32 {
            let peer = self.peers.read(eid);
            assert(peer.value != 0, 'NO_PEER');
            peer
        }

        /// Apply a bridge-in. Every branch ends with the amount either minted
        /// or quarantined -- it must never revert, or the escrow on the source
        /// chain is stranded behind a failed message.
        fn handle_mint(ref self: ContractState, message: @ByteArray) {
            let decoded = decode_mint(message);
            let registry = self.registry_dispatcher();

            // The snapshot rides along with the transfer, so a first-time
            // bridger arrives with their eligibility already proven. It is
            // still seq-gated: if a later revocation has overtaken this
            // message, the newer record wins and the mint quarantines.
            registry
                .apply_identity(
                    decoded.identity.evm_account,
                    decoded.identity.seq,
                    decoded.identity.verified,
                    decoded.identity.frozen,
                    decoded.identity.country,
                );

            let bound = registry.bind(decoded.sn_recipient, decoded.identity.evm_account);
            if !bound {
                self.quarantine(decoded.sn_recipient, decoded.amount, 'BINDING_CONFLICT');
                return;
            }

            if !self.token_dispatcher().can_bridge_mint(decoded.sn_recipient, decoded.amount) {
                self.quarantine(decoded.sn_recipient, decoded.amount, 'NOT_ELIGIBLE');
                return;
            }

            // Pool delivery mints into this contract's own custody instead, so
            // it must branch BEFORE the wallet mint or the amount is created
            // twice.
            if decoded.delivery == DELIVERY_POOL {
                self
                    .deliver_to_pool(
                        decoded.sn_recipient, decoded.amount, decoded.note_id, decoded.pool,
                    );
                return;
            }

            self.token_dispatcher().bridge_mint(decoded.sn_recipient, decoded.amount);
            self.emit(BridgeInMinted { recipient: decoded.sn_recipient, amount: decoded.amount });
        }

        /// Which pool this transfer may touch, and why not if it may touch none.
        ///
        /// A Veil pool is multi-asset, so the asset does not imply the pool and
        /// the message has to name one. A message that names none gets the
        /// gateway's default -- the main Veil pool. A message that names one is
        /// naming an address that arrived over the wire, and the gateway must
        /// not call that on a peer's say-so: it asks the factory first, and
        /// only a pool the factory itself deployed comes back usable.
        ///
        /// Nothing here reverts. A rejected pool is a policy outcome, and by the
        /// time this runs the tokens are already escrowed on the source chain --
        /// so the caller turns a reason into a wallet mint instead.
        fn resolve_pool(
            self: @ContractState, requested: ContractAddress,
        ) -> (ContractAddress, felt252) {
            let default_pool = self.pool.read();

            // The common case, and the one the operator already vetted.
            if requested.is_zero() || requested == default_pool {
                let reason = if default_pool.is_zero() {
                    'NO_POOL'
                } else {
                    0
                };
                return (default_pool, reason);
            }

            let factory = self.factory.read();
            if factory.is_zero() {
                // No factory wired, so nothing can vouch for this address.
                return (Zero::zero(), 'NO_FACTORY');
            }

            let mut call_data: Array<felt252> = array![];
            Serde::serialize(@requested, ref call_data);

            // A factory that reverts or answers strangely must not take the
            // message down with it, so the call is caught rather than trusted.
            match starknet::syscalls::call_contract_syscall(
                factory, selector!("get_pool_owner"), call_data.span(),
            ) {
                Result::Ok(returned) => {
                    // `pool_owner` is only ever written by `create_pool`, so a
                    // non-zero owner is proof the factory deployed this pool.
                    // Anything else -- an unknown address, a contract that is
                    // not a pool -- reads back zero.
                    if returned.len() == 1 && *returned.at(0) != 0 {
                        (requested, 0)
                    } else {
                        (Zero::zero(), 'UNKNOWN_POOL')
                    }
                },
                Result::Err(_) => (Zero::zero(), 'FACTORY_FAILED'),
            }
        }

        /// Fill the recipient's open note instead of minting to their wallet,
        /// degrading to the wallet on anything that stops it.
        ///
        /// The tokens are minted into this contract's own custody and the pool
        /// PULLS them via `transfer_from`. Nothing is pushed anywhere first, so
        /// a pool that reverts, is paused, or has not allow-listed this gateway
        /// simply never receives them, and the sweep hands the balance to the
        /// recipient. That is what makes calling a third-party contract safe
        /// from a path that must not revert: by the time this runs the tokens
        /// are already escrowed on the source chain.
        fn deliver_to_pool(
            ref self: ContractState,
            recipient: ContractAddress,
            amount: u256,
            note_id: felt252,
            requested_pool: ContractAddress,
        ) {
            let (pool, pool_reason) = self.resolve_pool(requested_pool);
            let reason = if pool_reason != 0 {
                pool_reason
            } else if note_id == 0 {
                'NO_NOTE_ID'
            } else if self.note_owners.read(note_id) != recipient {
                // Either unclaimed, or claimed by someone else. Filling it would
                // burn a one-shot note that is not this recipient's.
                'NOTE_NOT_CLAIMED'
            } else if amount.high != 0 {
                // `fill_open_note` takes a u128 and the note packs the amount
                // into its low 128 bits, so this cannot be represented.
                'AMOUNT_TOO_LARGE'
            } else {
                0
            };

            if reason != 0 {
                self.token_dispatcher().bridge_mint(recipient, amount);
                self.emit(DeliveryFellBack { recipient, amount, reason });
                return;
            }

            let token = self.token_dispatcher();
            let this = get_contract_address();
            token.bridge_mint(this, amount);
            token.approve(pool, amount);

            // A failing pool must not take the message down with it: the inner
            // call's writes roll back on error and execution continues here.
            let mut call_data: Array<felt252> = array![];
            Serde::serialize(@note_id, ref call_data);
            Serde::serialize(@token.contract_address, ref call_data);
            Serde::serialize(@amount.low, ref call_data);
            let outcome = starknet::syscalls::call_contract_syscall(
                pool, selector!("fill_open_note"), call_data.span(),
            );

            // Never leave a standing allowance behind.
            token.approve(pool, 0);

            // Whatever the call reported, the balance is the truth. Anything
            // still here was not taken and belongs to the recipient.
            let retained = token.balance_of(this);
            if retained != 0 {
                token.transfer(recipient, retained);
                self
                    .emit(
                        DeliveryFellBack {
                            recipient,
                            amount: retained,
                            reason: match outcome {
                                Result::Ok(_) => 'POOL_TOOK_NOTHING',
                                Result::Err(_) => 'POOL_REVERTED',
                            },
                        },
                    );
                return;
            }

            self.emit(DeliveredToPool { recipient, note_id, amount });
        }

        fn quarantine(
            ref self: ContractState, recipient: ContractAddress, amount: u256, reason: felt252,
        ) {
            self.pending.write(recipient, self.pending.read(recipient) + amount);
            self.total_pending.write(self.total_pending.read() + amount);
            self.emit(BridgeInQuarantined { recipient, amount, reason });
        }

        /// Mirrors `OAppCoreComponent::_lz_send`: collect the fee from the
        /// caller, approve the endpoint for it, then submit. The endpoint is
        /// paid by this contract, which is why the caller approves the gateway
        /// rather than the endpoint.
        fn lz_send(
            ref self: ContractState,
            caller: ContractAddress,
            dst_eid: u32,
            message: ByteArray,
            options: ByteArray,
            fee: MessagingFee,
            refund_address: ContractAddress,
        ) -> super::super::lz::MessageReceipt {
            let endpoint = self.endpoint.read();
            let this = get_contract_address();

            // Paying LayerZero's own fee token is not wired: the gateway holds
            // no ZRO and the Starknet endpoint prices in STRK. Checked before
            // any fee moves, so the caller is refused rather than charged.
            assert(fee.lz_token_fee == 0, 'LZ_TOKEN_FEE_UNSUPPORTED');

            if fee.native_fee != 0 {
                let native = IERC20Dispatcher { contract_address: self.native_token.read() };
                if caller != this {
                    assert(
                        native.allowance(caller, this) >= fee.native_fee,
                        'FEE_ALLOWANCE_TOO_LOW',
                    );
                    native.transfer_from(caller, this, fee.native_fee);
                }
                native.approve(endpoint, fee.native_fee);
            }

            IEndpointV2Dispatcher { contract_address: endpoint }
                .send(
                    MessagingParams {
                        dst_eid,
                        receiver: self.peer_or_revert(dst_eid),
                        message,
                        options,
                        pay_in_lz_token: false,
                    },
                    refund_address,
                )
        }
    }
}
