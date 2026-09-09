// The Starknet representation of an EVM ERC-3643 asset held in the lockbox.
//
// This is a real permissioned token, not a bearer wrapper: every transfer runs
// the full T-REX gate — pause, freeze, both parties verified, pluggable
// compliance — exactly like `erc3643/token.cairo`. The difference is the source
// of truth. Its identity registry is `VeilMirroredRegistry`, so eligibility is
// whatever the EVM registry last said, and its `compliance` slot still accepts
// a local `ERC3643Compliance` instance so issuer-specific rules can be layered
// on top of the mirrored ones without touching this contract.
//
// Supply is bridge-controlled: only the gateway mints (against tokens escrowed
// in the EVM lockbox) and only the gateway burns (to release them). Nothing
// else can change total supply, so `total_supply()` here should always equal
// the lockbox's escrowed balance minus anything still quarantined in the
// gateway. `tests/test_bridge.cairo` asserts that invariant across a round trip.
//
// `forced_transfer` is kept from the T-REX standard on purpose: it is the
// issuer's recovery lever when a holder is frozen or their wallet is bound to
// the wrong identity, since such a holder deliberately cannot bridge out on
// their own.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IBridgeRegistry<TContractState> {
    fn is_verified(self: @TContractState, account: ContractAddress) -> bool;
}

/// `MirroredCompliance`, or any contract with the same surface. The hooks carry
/// the names T-REX's `IModularCompliance` uses, because the rules that consume
/// them (MaxBalance above all) are ports of modules that rely on exactly this
/// call pattern to keep per-identity balances correct.
#[starknet::interface]
pub trait IBridgeCompliance<TContractState> {
    fn can_transfer(
        self: @TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
    fn transferred(
        ref self: TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    );
    fn created(ref self: TContractState, to: ContractAddress, amount: u256);
    fn destroyed(ref self: TContractState, from: ContractAddress, amount: u256);
}

#[starknet::interface]
pub trait IVeilBridgedERC3643<TContractState> {
    // ── Veil pool dispatcher surface (IERC3643Token) ────────────────────────
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState,
        sender: ContractAddress,
        recipient: ContractAddress,
        amount: u256,
    ) -> bool;
    fn identity_registry(self: @TContractState) -> ContractAddress;
    fn compliance(self: @TContractState) -> ContractAddress;

    // ── ERC-20 reads + approve ──────────────────────────────────────────────
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    fn totalSupply(self: @TContractState) -> u256;
    fn balanceOf(self: @TContractState, account: ContractAddress) -> u256;

    // ── Bridge-only supply control ──────────────────────────────────────────
    /// Credits a bridge-in. The gateway checks eligibility before calling and
    /// quarantines instead when the recipient is not eligible, so reaching here
    /// with an ineligible recipient is a bug and reverts.
    fn bridge_mint(ref self: TContractState, to: ContractAddress, amount: u256);
    /// The `bridge_mint` predicate as a view. The gateway must never revert
    /// inside `lz_receive` on a policy outcome — a reverted message strands
    /// tokens already escrowed on the source chain — so it asks first and
    /// quarantines when the answer is no.
    fn can_bridge_mint(self: @TContractState, to: ContractAddress, amount: u256) -> bool;
    /// Burns for a bridge-out, running the full transfer gate on the holder so
    /// a frozen or revoked holder cannot exit through the bridge.
    fn bridge_burn(ref self: TContractState, from: ContractAddress, amount: u256);

    // ── ERC-3643 admin ──────────────────────────────────────────────────────
    fn forced_transfer(
        ref self: TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
    fn set_address_frozen(ref self: TContractState, target: ContractAddress, frozen: bool);
    fn is_frozen(self: @TContractState, account: ContractAddress) -> bool;
    fn set_compliance(ref self: TContractState, compliance: ContractAddress);
    fn set_identity_registry(ref self: TContractState, identity_registry: ContractAddress);
    fn set_gateway(ref self: TContractState, gateway: ContractAddress);
    fn gateway(self: @TContractState) -> ContractAddress;
    fn add_agent(ref self: TContractState, agent: ContractAddress);
    fn remove_agent(ref self: TContractState, agent: ContractAddress);
    fn is_agent(self: @TContractState, account: ContractAddress) -> bool;
    fn pause(ref self: TContractState);
    fn unpause(ref self: TContractState);
    fn is_paused(self: @TContractState) -> bool;
    fn owner(self: @TContractState) -> ContractAddress;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

#[starknet::contract]
pub mod VeilBridgedERC3643 {
    use core::num::traits::Zero;
    use openzeppelin_security::pausable::PausableComponent;
    use openzeppelin_token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use super::{
        IBridgeComplianceDispatcher, IBridgeComplianceDispatcherTrait, IBridgeRegistryDispatcher,
        IBridgeRegistryDispatcherTrait, IVeilBridgedERC3643,
    };

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);

    // Same embedding discipline as erc3643/token.cairo: metadata is embedded,
    // the plain ERC20 transfer/transfer_from are NOT (this contract exposes
    // gated versions under the same names), and the read surface is re-exported
    // through this contract's own interface to avoid duplicate entrypoints.
    #[abi(embed_v0)]
    impl ERC20MetadataImpl = ERC20Component::ERC20MetadataImpl<ContractState>;
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;

    impl ERC20Config of ERC20Component::ImmutableConfig {
        const DECIMALS: u8 = 18;
    }

    #[derive(Drop, starknet::Event)]
    pub struct BridgeMinted {
        #[key]
        pub to: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BridgeBurned {
        #[key]
        pub from: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Frozen {
        #[key]
        pub account: ContractAddress,
        pub frozen: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AgentSet {
        #[key]
        pub agent: ContractAddress,
        pub enabled: bool,
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
        #[flat]
        ERC20Event: ERC20Component::Event,
        #[flat]
        PausableEvent: PausableComponent::Event,
        BridgeMinted: BridgeMinted,
        BridgeBurned: BridgeBurned,
        Frozen: Frozen,
        AgentSet: AgentSet,
        GatewaySet: GatewaySet,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        owner: ContractAddress,
        gateway: ContractAddress,
        identity_registry: ContractAddress,
        compliance: ContractAddress,
        agents: Map<ContractAddress, bool>,
        frozen: Map<ContractAddress, bool>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        owner: ContractAddress,
        identity_registry: ContractAddress,
        compliance: ContractAddress,
    ) {
        assert(!owner.is_zero(), 'ZERO_OWNER');
        assert(!identity_registry.is_zero(), 'ZERO_REGISTRY');
        self.erc20.initializer(name, symbol);
        self.owner.write(owner);
        self.identity_registry.write(identity_registry);
        self.compliance.write(compliance);
        self.agents.write(owner, true);
    }

    #[abi(embed_v0)]
    impl BridgedTokenImpl of IVeilBridgedERC3643<ContractState> {
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let from = get_caller_address();
            self.assert_can_move(from, recipient, amount);
            let ok = self.erc20.transfer(recipient, amount);
            self.notify_transferred(from, recipient, amount);
            ok
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            self.assert_can_move(sender, recipient, amount);
            let ok = self.erc20.transfer_from(sender, recipient, amount);
            self.notify_transferred(sender, recipient, amount);
            ok
        }

        fn identity_registry(self: @ContractState) -> ContractAddress {
            self.identity_registry.read()
        }

        fn compliance(self: @ContractState) -> ContractAddress {
            self.compliance.read()
        }

        fn total_supply(self: @ContractState) -> u256 {
            self.erc20.total_supply()
        }
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.erc20.balance_of(account)
        }
        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.erc20.allowance(owner, spender)
        }
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.erc20.approve(spender, amount)
        }
        fn totalSupply(self: @ContractState) -> u256 {
            self.erc20.total_supply()
        }
        fn balanceOf(self: @ContractState, account: ContractAddress) -> u256 {
            self.erc20.balance_of(account)
        }

        fn bridge_mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.assert_gateway();
            assert(!self.pausable.is_paused(), 'PAUSED');
            assert(!self.frozen.read(to), 'RECIPIENT_FROZEN');
            assert(self.is_verified(to), 'RECIPIENT_NOT_VERIFIED');
            let compliance = self.compliance.read();
            if !compliance.is_zero() {
                assert(
                    IBridgeComplianceDispatcher { contract_address: compliance }
                        .can_transfer(Zero::zero(), to, amount),
                    'COMPLIANCE_BLOCKED',
                );
            }
            self.erc20.mint(to, amount);
            if !compliance.is_zero() {
                IBridgeComplianceDispatcher { contract_address: compliance }.created(to, amount);
            }
            self.emit(BridgeMinted { to, amount });
        }

        fn can_bridge_mint(self: @ContractState, to: ContractAddress, amount: u256) -> bool {
            if self.pausable.is_paused() || self.frozen.read(to) {
                return false;
            }
            if !self.is_verified(to) {
                return false;
            }
            let compliance = self.compliance.read();
            compliance.is_zero()
                || IBridgeComplianceDispatcher { contract_address: compliance }
                    .can_transfer(Zero::zero(), to, amount)
        }

        fn bridge_burn(ref self: ContractState, from: ContractAddress, amount: u256) {
            self.assert_gateway();
            // Burning moves value out of this chain, so it runs the same gate a
            // transfer would: a frozen or revoked holder must not be able to
            // exit. Their route out is the issuer's `forced_transfer`.
            assert(!self.pausable.is_paused(), 'PAUSED');
            assert(!self.frozen.read(from), 'SENDER_FROZEN');
            assert(self.is_verified(from), 'SENDER_NOT_VERIFIED');
            let compliance = self.compliance.read();
            if !compliance.is_zero() {
                assert(
                    IBridgeComplianceDispatcher { contract_address: compliance }
                        .can_transfer(from, Zero::zero(), amount),
                    'COMPLIANCE_BLOCKED',
                );
            }
            self.erc20.burn(from, amount);
            if !compliance.is_zero() {
                IBridgeComplianceDispatcher { contract_address: compliance }
                    .destroyed(from, amount);
            }
            self.emit(BridgeBurned { from, amount });
        }

        fn forced_transfer(
            ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            self.assert_agent();
            assert(!self.pausable.is_paused(), 'PAUSED');
            assert(self.is_verified(to), 'RECIPIENT_NOT_VERIFIED');
            // Recovery/clawback: bypasses freeze, allowance AND the compliance
            // check by design, exactly as T-REX's forcedTransfer does. The
            // balance hook still fires, or the module's per-identity ledger
            // would drift from reality.
            self.erc20._transfer(from, to, amount);
            self.notify_transferred(from, to, amount);
            true
        }

        fn set_address_frozen(ref self: ContractState, target: ContractAddress, frozen: bool) {
            self.assert_agent();
            self.frozen.write(target, frozen);
            self.emit(Frozen { account: target, frozen });
        }

        fn is_frozen(self: @ContractState, account: ContractAddress) -> bool {
            self.frozen.read(account)
        }

        fn set_compliance(ref self: ContractState, compliance: ContractAddress) {
            self.assert_owner();
            self.compliance.write(compliance);
        }

        fn set_identity_registry(ref self: ContractState, identity_registry: ContractAddress) {
            self.assert_owner();
            assert(!identity_registry.is_zero(), 'ZERO_REGISTRY');
            self.identity_registry.write(identity_registry);
        }

        fn set_gateway(ref self: ContractState, gateway: ContractAddress) {
            self.assert_owner();
            assert(!gateway.is_zero(), 'ZERO_GATEWAY');
            self.gateway.write(gateway);
            self.emit(GatewaySet { gateway });
        }

        fn gateway(self: @ContractState) -> ContractAddress {
            self.gateway.read()
        }

        fn add_agent(ref self: ContractState, agent: ContractAddress) {
            self.assert_owner();
            assert(!agent.is_zero(), 'ZERO_AGENT');
            self.agents.write(agent, true);
            self.emit(AgentSet { agent, enabled: true });
        }

        fn remove_agent(ref self: ContractState, agent: ContractAddress) {
            self.assert_owner();
            self.agents.write(agent, false);
            self.emit(AgentSet { agent, enabled: false });
        }

        fn is_agent(self: @ContractState, account: ContractAddress) -> bool {
            self.agents.read(account)
        }

        fn pause(ref self: ContractState) {
            self.assert_owner();
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.assert_owner();
            self.pausable.unpause();
        }

        fn is_paused(self: @ContractState) -> bool {
            self.pausable.is_paused()
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_owner();
            assert(!new_owner.is_zero(), 'ZERO_OWNER');
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            self.agents.write(new_owner, true);
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        fn assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'ONLY_OWNER');
        }

        fn assert_agent(self: @ContractState) {
            assert(self.agents.read(get_caller_address()), 'ONLY_AGENT');
        }

        fn assert_gateway(self: @ContractState) {
            let gateway = self.gateway.read();
            assert(!gateway.is_zero(), 'GATEWAY_UNSET');
            assert(get_caller_address() == gateway, 'ONLY_GATEWAY');
        }

        fn is_verified(self: @ContractState, account: ContractAddress) -> bool {
            IBridgeRegistryDispatcher { contract_address: self.identity_registry.read() }
                .is_verified(account)
        }

        /// Tell the compliance module a transfer happened. MaxBalance keeps a
        /// per-identity ledger that only stays correct if every movement is
        /// reported, so this fires on ordinary transfers AND on the forced
        /// transfers that deliberately skip the check.
        fn notify_transferred(
            ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) {
            let compliance = self.compliance.read();
            if !compliance.is_zero() {
                IBridgeComplianceDispatcher { contract_address: compliance }
                    .transferred(from, to, amount);
            }
        }

        fn assert_can_move(
            ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) {
            assert(!self.pausable.is_paused(), 'PAUSED');
            assert(!self.frozen.read(from), 'SENDER_FROZEN');
            assert(!self.frozen.read(to), 'RECIPIENT_FROZEN');
            assert(self.is_verified(from), 'SENDER_NOT_VERIFIED');
            assert(self.is_verified(to), 'RECIPIENT_NOT_VERIFIED');
            let compliance = self.compliance.read();
            if !compliance.is_zero() {
                assert(
                    IBridgeComplianceDispatcher { contract_address: compliance }
                        .can_transfer(from, to, amount),
                    'COMPLIANCE_BLOCKED',
                );
            }
        }
    }
}
