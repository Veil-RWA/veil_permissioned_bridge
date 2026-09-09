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
        KIND_GLOBAL, KIND_IDENTITY, KIND_MINT, decode_global, decode_identity, decode_mint,
        encode_unlock, kind,
    };
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

            self.token_dispatcher().bridge_mint(decoded.sn_recipient, decoded.amount);
            self.emit(BridgeInMinted { recipient: decoded.sn_recipient, amount: decoded.amount });
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
