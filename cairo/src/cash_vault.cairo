// VeilCashVault — the cash leg (USDC) into a Veil pool, without naming the
// holder.
//
// 1. The holder's account creates an empty USDC open note in the pool
//    (`create_open_note`, proven). Its owner is recorded only encrypted to the
//    pool's auditor.
// 2. On the source chain (Ethereum), the holder's wallet burns USDC through
//    Circle's CCTP with this contract as BOTH mint recipient and destination
//    caller, and the note id as the 32-byte hook data.
// 3. `receive_deposit` relays Circle's attested message. Only this contract
//    can, because it is the destination caller. In the same call it fills the
//    named note (it is an allowed adapter of the pool).
//
// Public: the burn on the source chain (wallet, amount, note id) and a note
// filled here by the vault. Not public: which Starknet account owns the note.
//
// A deposit that cannot be delivered stays here, owed to that deposit alone:
//   * `retry_delivery` fills the note once it can take it (e.g. the pool was
//     paused);
//   * `refund` sends it back through CCTP to the address that burned it, on the
//     chain it came from, once the note can no longer take it (already filled,
//     not an empty USDC open note of this pool, or no note named).
// Nothing is ever paid anywhere else.
//
// Fixed configuration, no admin, nothing to rescue.

use starknet::ContractAddress;

pub const CASH_NONE: u8 = 0;
pub const CASH_DELIVERED: u8 = 1;
/// Received but not delivered: retry or refund.
pub const CASH_HELD: u8 = 2;
pub const CASH_REFUNDED: u8 = 3;

#[derive(Copy, Drop, Serde, PartialEq, Debug, starknet::Store)]
pub struct CashDeposit {
    /// The USDC open note it fills; 0 when the hook data named none.
    pub note_id: felt252,
    /// What CCTP minted here (after any CCTP fee).
    pub amount: u128,
    /// Where it came from, and who burned it (CCTP's 32-byte word): the only
    /// destination a refund can have.
    pub source_domain: u32,
    pub sender: u256,
    pub status: u8,
}

#[starknet::interface]
pub trait IVeilCashVault<TContractState> {
    /// Permissionless relay of Circle's attested burn message. Returns the
    /// deposit id, or 0 for a message this vault only relays for someone else.
    fn receive_deposit(
        ref self: TContractState, message: ByteArray, attestation: ByteArray,
    ) -> felt252;
    /// Permissionless. Fills the note of a held deposit; reverts if it still
    /// cannot.
    fn retry_delivery(ref self: TContractState, deposit_id: felt252);
    /// Permissionless. Returns a held deposit whose note can no longer take it
    /// to its sender on its source chain, as a CCTP Standard Transfer.
    fn refund(ref self: TContractState, deposit_id: felt252, max_fee: u256);
    fn deposit_of(self: @TContractState, deposit_id: felt252) -> CashDeposit;
    fn deposit_id_of(self: @TContractState, source_domain: u32, nonce: u256) -> felt252;
    fn pool(self: @TContractState) -> ContractAddress;
    fn usdc(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
pub mod VeilCashVault {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
    use crate::bytes::read_be;
    use crate::cash_cctp::{
        EMPTY_OPEN_NOTE, HOOK_DATA_INDEX, ICashERC20Dispatcher, ICashERC20DispatcherTrait,
        IMessageTransmitterV2Dispatcher, IMessageTransmitterV2DispatcherTrait,
        ITokenMessengerMinterV2Dispatcher, ITokenMessengerMinterV2DispatcherTrait,
        IVeilCashPoolDispatcher, IVeilCashPoolDispatcherTrait, MESSAGE_SENDER_INDEX,
        MINT_RECIPIENT_INDEX, NONCE_INDEX, SOURCE_DOMAIN_INDEX, STANDARD_FINALITY, word_of,
    };
    use super::{
        CASH_DELIVERED, CASH_HELD, CASH_NONE, CASH_REFUNDED, CashDeposit, IVeilCashVault,
    };

    #[storage]
    struct Storage {
        pool: ContractAddress,
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        token_messenger: ContractAddress,
        deposits: Map<felt252, CashDeposit>,
    }

    /// Events carry no account: the note id and amount are all the chain needs.
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        CashReceived: CashReceived,
        CashDelivered: CashDelivered,
        CashHeld: CashHeld,
        CashRefunded: CashRefunded,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CashReceived {
        #[key]
        pub deposit_id: felt252,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CashDelivered {
        #[key]
        pub deposit_id: felt252,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CashHeld {
        #[key]
        pub deposit_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CashRefunded {
        #[key]
        pub deposit_id: felt252,
        pub amount: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool: ContractAddress,
        usdc: ContractAddress,
        message_transmitter: ContractAddress,
        token_messenger: ContractAddress,
    ) {
        assert(!pool.is_zero(), 'ZERO_POOL');
        assert(!usdc.is_zero(), 'ZERO_USDC');
        assert(!message_transmitter.is_zero(), 'ZERO_TRANSMITTER');
        assert(!token_messenger.is_zero(), 'ZERO_TOKEN_MESSENGER');
        self.pool.write(pool);
        self.usdc.write(usdc);
        self.message_transmitter.write(message_transmitter);
        self.token_messenger.write(token_messenger);
    }

    #[abi(embed_v0)]
    impl CashVaultImpl of IVeilCashVault<ContractState> {
        fn receive_deposit(
            ref self: ContractState, message: ByteArray, attestation: ByteArray,
        ) -> felt252 {
            assert(message.len() >= HOOK_DATA_INDEX, 'BAD_CCTP_MESSAGE');
            let this = get_contract_address();
            let minted_here = read_be(@message, MINT_RECIPIENT_INDEX, 32) == word_of(this);
            let source_domain: u32 = read_be(@message, SOURCE_DOMAIN_INDEX, 4)
                .low
                .try_into()
                .unwrap();
            let nonce = read_be(@message, NONCE_INDEX, 32);
            let sender = read_be(@message, MESSAGE_SENDER_INDEX, 32);
            // The note is exactly 32 bytes of hook data. Anything else names no
            // note: the deposit is kept and can only be refunded.
            let note_id: felt252 = if message.len() == HOOK_DATA_INDEX + 32 {
                match read_be(@message, HOOK_DATA_INDEX, 32).try_into() {
                    Option::Some(n) => n,
                    Option::None => 0,
                }
            } else {
                0
            };

            let usdc = ICashERC20Dispatcher { contract_address: self.usdc.read() };
            let before = usdc.balance_of(this);
            let ok = IMessageTransmitterV2Dispatcher {
                contract_address: self.message_transmitter.read(),
            }
                .receive_message(message, attestation);
            assert(ok, 'CCTP_RECEIVE_FAILED');
            // Named as destination caller but minted to someone else: relayed,
            // and nothing here is ours to account for.
            if !minted_here {
                return 0;
            }
            let received = usdc.balance_of(this) - before;
            assert(received != 0, 'NOTHING_MINTED');
            assert(received.high == 0, 'AMOUNT_TOO_LARGE');

            let deposit_id = deposit_id(source_domain, nonce);
            assert(self.deposits.read(deposit_id).status == CASH_NONE, 'DEPOSIT_EXISTS');
            self
                .deposits
                .write(
                    deposit_id,
                    CashDeposit {
                        note_id, amount: received.low, source_domain, sender, status: CASH_HELD,
                    },
                );
            self.emit(CashReceived { deposit_id, note_id, amount: received.low });
            // Never revert once the USDC has arrived: a refused fill keeps the
            // deposit HELD for `retry_delivery` or `refund`.
            if !self.deliver(deposit_id, false) {
                self.emit(CashHeld { deposit_id });
            }
            deposit_id
        }

        fn retry_delivery(ref self: ContractState, deposit_id: felt252) {
            assert(self.deposits.read(deposit_id).status == CASH_HELD, 'DEPOSIT_NOT_HELD');
            self.deliver(deposit_id, true);
        }

        fn refund(ref self: ContractState, deposit_id: felt252, max_fee: u256) {
            let mut d = self.deposits.read(deposit_id);
            assert(d.status == CASH_HELD, 'DEPOSIT_NOT_HELD');
            // While the note can still take it, the deposit is the holder's in
            // the pool, not the sender's back: retry instead.
            assert(!self.fillable(d.note_id), 'NOTE_STILL_FILLABLE');
            d.status = CASH_REFUNDED;
            self.deposits.write(deposit_id, d);

            let this = get_contract_address();
            let usdc = ICashERC20Dispatcher { contract_address: self.usdc.read() };
            let messenger = self.token_messenger.read();
            let before = usdc.balance_of(this);
            usdc.approve(messenger, d.amount.into());
            // Standard Transfer, anyone may relay it on the source chain.
            ITokenMessengerMinterV2Dispatcher { contract_address: messenger }
                .deposit_for_burn(
                    d.amount.into(),
                    d.source_domain,
                    d.sender,
                    usdc.contract_address,
                    0,
                    max_fee,
                    STANDARD_FINALITY,
                );
            assert(usdc.balance_of(this) == before - d.amount.into(), 'USDC_NOT_BURNED');
            self.emit(CashRefunded { deposit_id, amount: d.amount });
        }

        fn deposit_of(self: @ContractState, deposit_id: felt252) -> CashDeposit {
            self.deposits.read(deposit_id)
        }

        fn deposit_id_of(self: @ContractState, source_domain: u32, nonce: u256) -> felt252 {
            deposit_id(source_domain, nonce)
        }

        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }

        fn usdc(self: @ContractState) -> ContractAddress {
            self.usdc.read()
        }
    }

    /// CCTP nonces are unique per source domain.
    fn deposit_id(source_domain: u32, nonce: u256) -> felt252 {
        poseidon_hash_span(
            array!['VEIL_CASH', source_domain.into(), nonce.low.into(), nonce.high.into()].span(),
        )
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// An empty USDC open note of this pool.
        fn fillable(self: @ContractState, note_id: felt252) -> bool {
            if note_id == 0 {
                return false;
            }
            let pool = IVeilCashPoolDispatcher { contract_address: self.pool.read() };
            if pool.get_open_note(note_id).token != self.usdc.read() {
                return false;
            }
            let note = *pool.get_notes_batch(array![note_id]).at(0);
            note.encrypted_amount == EMPTY_OPEN_NOTE
        }

        // Approve the pool, let it pull the amount into the note, and hold no
        // allowance afterwards. With `must_succeed` false, a refusing pool is
        // survived and the deposit stays HELD.
        fn deliver(ref self: ContractState, deposit_id: felt252, must_succeed: bool) -> bool {
            let mut d = self.deposits.read(deposit_id);
            if !self.fillable(d.note_id) {
                assert(!must_succeed, 'NOTE_NOT_FILLABLE');
                return false;
            }
            let pool = self.pool.read();
            let this = get_contract_address();
            let usdc = ICashERC20Dispatcher { contract_address: self.usdc.read() };
            let before = usdc.balance_of(this);
            usdc.approve(pool, d.amount.into());
            let mut call_data: Array<felt252> = array![];
            d.note_id.serialize(ref call_data);
            usdc.contract_address.serialize(ref call_data);
            d.amount.serialize(ref call_data);
            let outcome = call_contract_syscall(pool, selector!("fill_open_note"), call_data.span());
            let taken = usdc.balance_of(this) == before - d.amount.into();
            if must_succeed {
                outcome.unwrap_syscall();
                assert(taken, 'POOL_TOOK_NOTHING');
            } else if !(outcome.is_ok() && taken) {
                usdc.approve(pool, 0);
                return false;
            }
            d.status = CASH_DELIVERED;
            self.deposits.write(deposit_id, d);
            self.emit(CashDelivered { deposit_id, note_id: d.note_id, amount: d.amount });
            true
        }
    }
}
