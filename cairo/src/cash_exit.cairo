// VeilCashExit — the cash leg (USDC) out of a Veil pool to an address on
// another CCTP chain (Ethereum), without naming the holder.
//
// One proven pool `invoke` (in token = out token = USDC, adapter = this
// contract) spends `amount + 1` of the holder's USDC notes, pays it here and
// calls `privacy_invoke`, which:
//   1. burns `amount` through Circle's CCTP to the recipient on the destination
//      chain, as a transfer anyone may relay there;
//   2. hands 1 unit back into the invoke's open note: a pool invoke must return
//      a non-zero deposit.
// The pool pays this contract and calls it inside one proven settle, so the
// holder's account never appears. Public: the amount and the recipient, as in
// any CCTP transfer.
//
// Stateless, fixed configuration, no admin. A failure anywhere reverts the
// whole invoke, so nothing is ever left here.

use starknet::ContractAddress;
use crate::cash_cctp::OpenNoteDeposit;

/// What an exit hands back into the invoke's open note.
pub const EXIT_CHANGE: u128 = 1;
/// A CCTP recipient on an EVM chain: a 20-byte address.
pub const EVM_ADDRESS_BOUND: u256 = 0x10000000000000000000000000000000000000000;

#[starknet::interface]
pub trait IVeilCashExit<TContractState> {
    /// The pool only (invoke adapter, selector `privacy_invoke`). The pool has
    /// just paid this contract `amount + 1` USDC.
    ///
    /// - `open_note_id`: the invoke's own open note (USDC), which gets the 1
    ///   unit of change.
    /// - `amount`: USDC (6 dp) to send.
    /// - `recipient`: the EVM address that receives it.
    /// - `max_fee` / `min_finality`: CCTP parameters (Standard: 0 / 2000;
    ///   Fast: a fee / 1000).
    fn privacy_invoke(
        ref self: TContractState,
        open_note_id: felt252,
        amount: u128,
        recipient: u256,
        max_fee: u256,
        min_finality: u32,
    ) -> Array<OpenNoteDeposit>;
    fn pool(self: @TContractState) -> ContractAddress;
    fn usdc(self: @TContractState) -> ContractAddress;
    fn token_messenger(self: @TContractState) -> ContractAddress;
    fn destination_domain(self: @TContractState) -> u32;
}

#[starknet::contract]
pub mod VeilCashExit {
    use core::num::traits::Zero;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::cash_cctp::{
        ICashERC20Dispatcher, ICashERC20DispatcherTrait, ITokenMessengerMinterV2Dispatcher,
        ITokenMessengerMinterV2DispatcherTrait, OpenNoteDeposit,
    };
    use super::{EVM_ADDRESS_BOUND, EXIT_CHANGE, IVeilCashExit};

    #[storage]
    struct Storage {
        pool: ContractAddress,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        destination_domain: u32,
    }

    /// Deliberately carries no account.
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        CashExitBurned: CashExitBurned,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CashExitBurned {
        pub amount: u128,
        pub destination_domain: u32,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool: ContractAddress,
        usdc: ContractAddress,
        token_messenger: ContractAddress,
        destination_domain: u32,
    ) {
        assert(!pool.is_zero(), 'ZERO_POOL');
        assert(!usdc.is_zero(), 'ZERO_USDC');
        assert(!token_messenger.is_zero(), 'ZERO_TOKEN_MESSENGER');
        self.pool.write(pool);
        self.usdc.write(usdc);
        self.token_messenger.write(token_messenger);
        self.destination_domain.write(destination_domain);
    }

    #[abi(embed_v0)]
    impl CashExitImpl of IVeilCashExit<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            open_note_id: felt252,
            amount: u128,
            recipient: u256,
            max_fee: u256,
            min_finality: u32,
        ) -> Array<OpenNoteDeposit> {
            let pool = self.pool.read();
            assert(get_caller_address() == pool, 'ONLY_POOL');
            assert(amount != 0, 'ZERO_AMOUNT');
            assert(recipient != 0 && recipient < EVM_ADDRESS_BOUND, 'BAD_RECIPIENT');
            let this = get_contract_address();
            let usdc = ICashERC20Dispatcher { contract_address: self.usdc.read() };
            let before = usdc.balance_of(this);
            // The pool paid `amount + change` just before this call (same
            // transaction, nothing in between).
            assert(before >= amount.into() + EXIT_CHANGE.into(), 'USDC_NOT_RECEIVED');

            let messenger = self.token_messenger.read();
            let destination_domain = self.destination_domain.read();
            usdc.approve(messenger, amount.into());
            ITokenMessengerMinterV2Dispatcher { contract_address: messenger }
                .deposit_for_burn(
                    amount.into(),
                    destination_domain,
                    recipient,
                    usdc.contract_address,
                    0,
                    max_fee,
                    min_finality,
                );
            assert(usdc.balance_of(this) == before - amount.into(), 'USDC_NOT_BURNED');
            self.emit(CashExitBurned { amount, destination_domain });

            // The change goes back into the invoke's open note; the pool pulls it.
            usdc.approve(pool, EXIT_CHANGE.into());
            array![
                OpenNoteDeposit {
                    note_id: open_note_id, token: usdc.contract_address, amount: EXIT_CHANGE,
                },
            ]
        }

        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }
        fn usdc(self: @ContractState) -> ContractAddress {
            self.usdc.read()
        }
        fn token_messenger(self: @ContractState) -> ContractAddress {
            self.token_messenger.read()
        }
        fn destination_domain(self: @ContractState) -> u32 {
            self.destination_domain.read()
        }
    }
}
