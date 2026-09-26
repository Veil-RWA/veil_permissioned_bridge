// TEST ONLY. Stand-ins for Circle's contracts on Starknet, for the cash leg's
// tests (copied from HyperVeil's, which read them from the real source). The
// Veil pool is NOT mocked: the tests deploy the real `VeilERC3643`.
//
//   * FiatToken (USDC): an ERC-20 with `paused()` and `is_blocklisted()`;
//     paused, it refuses every transfer (the blocklist is only reported);
//   * token messenger: `deposit_for_burn` / `deposit_for_burn_with_hook` pull
//     and burn the amount, and record the call;
//   * message transmitter: `receive_message` enforces the destination caller
//     and mints `amount - fee_executed` to the mint recipient, once.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockCashToken<TContractState> {
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
    fn set_paused(ref self: TContractState, paused: bool);
    fn paused(self: @TContractState) -> bool;
    fn is_blocklisted(self: @TContractState, account: ContractAddress) -> bool;
    fn set_blocklisted(ref self: TContractState, account: ContractAddress, blocklisted: bool);
}

#[starknet::contract]
pub mod MockCashToken {
    use openzeppelin_token::erc20::{DefaultConfig, ERC20Component};
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use super::IMockCashToken;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        paused: bool,
        blocklisted: Map<ContractAddress, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    impl Hooks of ERC20Component::ERC20HooksTrait<ContractState> {
        fn before_update(
            ref self: ERC20Component::ComponentState<ContractState>,
            from: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) {
            let contract = self.get_contract();
            assert(!contract.paused.read(), 'MOCK_USDC_PAUSED');
        }
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.erc20.initializer("USD Coin", "USDC");
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockCashToken<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.erc20.mint(to, amount);
        }
        fn set_paused(ref self: ContractState, paused: bool) {
            self.paused.write(paused);
        }
        fn paused(self: @ContractState) -> bool {
            self.paused.read()
        }
        fn is_blocklisted(self: @ContractState, account: ContractAddress) -> bool {
            self.blocklisted.read(account)
        }
        fn set_blocklisted(ref self: ContractState, account: ContractAddress, blocklisted: bool) {
            self.blocklisted.write(account, blocklisted);
        }
    }
}

/// What the last burn was called with.
#[derive(Drop, Serde, starknet::Store)]
pub struct CashBurnCall {
    pub caller: ContractAddress,
    pub amount: u256,
    pub destination_domain: u32,
    pub mint_recipient: u256,
    pub burn_token: ContractAddress,
    pub destination_caller: u256,
    pub max_fee: u256,
    pub min_finality_threshold: u32,
}

#[starknet::interface]
pub trait IMockCashMessenger<TContractState> {
    fn last_burn(self: @TContractState) -> CashBurnCall;
    fn last_hook_data(self: @TContractState) -> ByteArray;
    fn burn_count(self: @TContractState) -> u32;
}

#[starknet::contract]
pub mod MockCashMessenger {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use crate::cash_cctp::ITokenMessengerMinterV2;
    use super::{CashBurnCall, IMockCashMessenger};

    #[starknet::interface]
    trait IPull<T> {
        fn transfer_from(
            ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
        ) -> bool;
    }

    #[storage]
    struct Storage {
        last_burn: CashBurnCall,
        last_hook_data: ByteArray,
        burn_count: u32,
    }

    #[abi(embed_v0)]
    impl MessengerImpl of ITokenMessengerMinterV2<ContractState> {
        fn deposit_for_burn(
            ref self: ContractState,
            amount: u256,
            destination_domain: u32,
            mint_recipient: u256,
            burn_token: ContractAddress,
            destination_caller: u256,
            max_fee: u256,
            min_finality_threshold: u32,
        ) {
            self
                .burn(
                    amount,
                    destination_domain,
                    mint_recipient,
                    burn_token,
                    destination_caller,
                    max_fee,
                    min_finality_threshold,
                    "",
                );
        }

        fn deposit_for_burn_with_hook(
            ref self: ContractState,
            amount: u256,
            destination_domain: u32,
            mint_recipient: u256,
            burn_token: ContractAddress,
            destination_caller: u256,
            max_fee: u256,
            min_finality_threshold: u32,
            hook_data: ByteArray,
        ) {
            assert(hook_data.len() != 0, 'MOCK_EMPTY_HOOK');
            self
                .burn(
                    amount,
                    destination_domain,
                    mint_recipient,
                    burn_token,
                    destination_caller,
                    max_fee,
                    min_finality_threshold,
                    hook_data,
                );
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn burn(
            ref self: ContractState,
            amount: u256,
            destination_domain: u32,
            mint_recipient: u256,
            burn_token: ContractAddress,
            destination_caller: u256,
            max_fee: u256,
            min_finality_threshold: u32,
            hook_data: ByteArray,
        ) {
            // Circle's own checks (token_messenger_minter_v2 `_deposit_for_burn`).
            assert(amount != 0, 'MOCK_ZERO_AMOUNT');
            assert(mint_recipient != 0, 'MOCK_ZERO_RECIPIENT');
            assert(max_fee < amount, 'MOCK_MAX_FEE');
            let caller = get_caller_address();
            // Pulled and held here: "burned" as far as the caller can tell.
            IPullDispatcher { contract_address: burn_token }
                .transfer_from(caller, get_contract_address(), amount);
            self
                .last_burn
                .write(
                    CashBurnCall {
                        caller,
                        amount,
                        destination_domain,
                        mint_recipient,
                        burn_token,
                        destination_caller,
                        max_fee,
                        min_finality_threshold,
                    },
                );
            self.last_hook_data.write(hook_data);
            self.burn_count.write(self.burn_count.read() + 1);
        }
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockCashMessenger<ContractState> {
        fn last_burn(self: @ContractState) -> CashBurnCall {
            self.last_burn.read()
        }
        fn last_hook_data(self: @ContractState) -> ByteArray {
            self.last_hook_data.read()
        }
        fn burn_count(self: @ContractState) -> u32 {
            self.burn_count.read()
        }
    }
}

#[starknet::contract]
pub mod MockCashTransmitter {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};
    use crate::bytes::read_be;
    use crate::cash_cctp::{
        AMOUNT_INDEX, DESTINATION_CALLER_INDEX, FEE_EXECUTED_INDEX, IMessageTransmitterV2,
        MINT_RECIPIENT_INDEX, word_of,
    };
    use super::{IMockCashTokenDispatcher, IMockCashTokenDispatcherTrait};

    #[storage]
    struct Storage {
        usdc: ContractAddress,
        used: Map<felt252, bool>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, usdc: ContractAddress) {
        self.usdc.write(usdc);
    }

    #[abi(embed_v0)]
    impl TransmitterImpl of IMessageTransmitterV2<ContractState> {
        fn receive_message(
            ref self: ContractState, message: ByteArray, attestation: ByteArray,
        ) -> bool {
            assert(attestation == "ATTESTED", 'MOCK_BAD_ATTESTATION');
            let destination_caller = read_be(@message, DESTINATION_CALLER_INDEX, 32);
            assert(
                destination_caller == 0 || destination_caller == word_of(get_caller_address()),
                'MOCK_WRONG_DESTINATION_CALLER',
            );
            let mut words: Array<felt252> = array![];
            let mut i = 0;
            while i != message.len() {
                words.append(message.at(i).unwrap().into());
                i += 1;
            }
            let key = poseidon_hash_span(words.span());
            assert(!self.used.read(key), 'MOCK_NONCE_USED');
            self.used.write(key, true);

            let recipient: felt252 = read_be(@message, MINT_RECIPIENT_INDEX, 32)
                .try_into()
                .unwrap();
            let recipient: ContractAddress = recipient.try_into().unwrap();
            assert(!recipient.is_zero(), 'MOCK_ZERO_RECIPIENT');
            let amount = read_be(@message, AMOUNT_INDEX, 32);
            let fee_executed = read_be(@message, FEE_EXECUTED_INDEX, 32);
            IMockCashTokenDispatcher { contract_address: self.usdc.read() }
                .mint(recipient, amount - fee_executed);
            true
        }
    }
}
