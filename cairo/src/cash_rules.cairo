// VeilCashRules — how Circle's USDC sits in a Veil pool as the cash leg.
//
// The pool gates every token it carries. USDC has no identity registry and no
// permission manager, so it is registered as a RULES token and this contract
// answers the pool's `ITransferRules` questions with USDC's OWN rules, read
// live from Circle's FiatToken on Starknet (`circlefin/stablecoin-starknet`):
//
//   * paused      <- `paused()`: nothing moves in the pool either;
//   * frozen      <- `is_blocklisted(account)`: a blocklisted account can
//     neither send nor receive, and cannot hold;
//   * nothing else: no locks, no whole-balance rule, no investor cap, no
//     minimum.
//
// Stricter policy (a KYC list for who may hold the cash leg) is a different
// rules contract, as HyperVeil's `HyperVeilKycRules` is; the pool owner can
// rotate to one with `set_token_rules`.
//
// Restated from `veil::interfaces::IVeilERC3643::ITransferRules` (names,
// argument order and types must match; the tests run against the real pool).

use starknet::ContractAddress;

#[starknet::interface]
pub trait ITransferRules<TContractState> {
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
}

/// Circle's FiatToken on Starknet: the two rules this contract mirrors.
#[starknet::interface]
pub trait ICircleFiatToken<TContractState> {
    fn paused(self: @TContractState) -> bool;
    fn is_blocklisted(self: @TContractState, account: ContractAddress) -> bool;
}

#[starknet::interface]
pub trait IVeilCashRules<TContractState> {
    fn token(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
pub mod VeilCashRules {
    use core::num::traits::Zero;
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{
        ICircleFiatTokenDispatcher, ICircleFiatTokenDispatcherTrait, ITransferRules,
        IVeilCashRules,
    };

    #[storage]
    struct Storage {
        token: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, token: ContractAddress) {
        assert(!token.is_zero(), 'ZERO_TOKEN');
        self.token.write(token);
    }

    #[abi(embed_v0)]
    impl RulesImpl of ITransferRules<ContractState> {
        fn can_hold(self: @ContractState, account: ContractAddress) -> bool {
            !self.blocklisted(account)
        }
        fn is_frozen(self: @ContractState, account: ContractAddress) -> bool {
            self.blocklisted(account)
        }
        fn is_paused(self: @ContractState) -> bool {
            ICircleFiatTokenDispatcher { contract_address: self.token.read() }.paused()
        }
        fn transfers_enabled(self: @ContractState) -> bool {
            true
        }
        fn can_transfer(
            self: @ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            !self.blocklisted(from) && !self.blocklisted(to)
        }
        fn requires_full_balance(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> bool {
            false
        }
        fn locked_amount(self: @ContractState, account: ContractAddress) -> u256 {
            0
        }
        fn new_investor_capped(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> bool {
            false
        }
        fn min_residual(
            self: @ContractState, from: ContractAddress, to: ContractAddress,
        ) -> (u256, bool) {
            (0, false)
        }
    }

    #[abi(embed_v0)]
    impl CashRulesImpl of IVeilCashRules<ContractState> {
        fn token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn blocklisted(self: @ContractState, account: ContractAddress) -> bool {
            ICircleFiatTokenDispatcher { contract_address: self.token.read() }
                .is_blocklisted(account)
        }
    }
}
