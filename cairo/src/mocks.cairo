// TEST ONLY. Stand-ins for the two things the bridge gateway talks to that are
// not part of this repo: the LayerZero endpoint and the STRK fee token.
//
// The endpoint mock records exactly what the gateway handed it, so a test can
// assert on the bytes that would go over the wire rather than trusting the
// gateway's own events.

use starknet::ContractAddress;
use veil_bridge::lz::Bytes32;

#[starknet::interface]
pub trait IMockEndpointExt<TContractState> {
    fn set_fee(ref self: TContractState, native_fee: u256, lz_token_fee: u256);
    fn last_dst_eid(self: @TContractState) -> u32;
    fn last_receiver(self: @TContractState) -> Bytes32;
    fn last_message(self: @TContractState) -> ByteArray;
    fn last_options(self: @TContractState) -> ByteArray;
    fn last_refund_address(self: @TContractState) -> ContractAddress;
    fn last_delegate(self: @TContractState) -> ContractAddress;
    fn send_count(self: @TContractState) -> u32;
}

#[starknet::contract]
pub mod MockLzEndpoint {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::ContractAddress;
    use veil_bridge::lz::{
        Bytes32, IEndpointV2, MessageReceipt, MessagingFee, MessagingParams,
    };
    use super::IMockEndpointExt;

    #[storage]
    struct Storage {
        native_fee: u256,
        lz_token_fee: u256,
        last_dst_eid: u32,
        last_receiver: Bytes32,
        last_message: ByteArray,
        last_options: ByteArray,
        last_refund_address: ContractAddress,
        last_delegate: ContractAddress,
        send_count: u32,
        nonce: u64,
    }

    #[abi(embed_v0)]
    impl EndpointImpl of IEndpointV2<ContractState> {
        fn send(
            ref self: ContractState, params: MessagingParams, refund_address: ContractAddress,
        ) -> MessageReceipt {
            self.last_dst_eid.write(params.dst_eid);
            self.last_receiver.write(params.receiver);
            self.last_message.write(params.message);
            self.last_options.write(params.options);
            self.last_refund_address.write(refund_address);
            self.send_count.write(self.send_count.read() + 1);
            let nonce = self.nonce.read() + 1;
            self.nonce.write(nonce);
            MessageReceipt { guid: Bytes32 { value: nonce.into() }, nonce, payees: array![] }
        }

        fn quote(
            self: @ContractState, params: MessagingParams, sender: ContractAddress,
        ) -> MessagingFee {
            MessagingFee {
                native_fee: self.native_fee.read(), lz_token_fee: self.lz_token_fee.read(),
            }
        }

        fn set_delegate(ref self: ContractState, delegate: ContractAddress) {
            self.last_delegate.write(delegate);
        }
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockEndpointExt<ContractState> {
        fn set_fee(ref self: ContractState, native_fee: u256, lz_token_fee: u256) {
            self.native_fee.write(native_fee);
            self.lz_token_fee.write(lz_token_fee);
        }
        fn last_dst_eid(self: @ContractState) -> u32 {
            self.last_dst_eid.read()
        }
        fn last_receiver(self: @ContractState) -> Bytes32 {
            self.last_receiver.read()
        }
        fn last_message(self: @ContractState) -> ByteArray {
            self.last_message.read()
        }
        fn last_options(self: @ContractState) -> ByteArray {
            self.last_options.read()
        }
        fn last_refund_address(self: @ContractState) -> ContractAddress {
            self.last_refund_address.read()
        }
        fn last_delegate(self: @ContractState) -> ContractAddress {
            self.last_delegate.read()
        }
        fn send_count(self: @ContractState) -> u32 {
            self.send_count.read()
        }
    }
}

/// TEST ONLY. Plain ERC-20 standing in for STRK as the endpoint's fee token.
#[starknet::interface]
pub trait IMockNativeTokenExt<TContractState> {
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockNativeToken {
    use openzeppelin_token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use starknet::ContractAddress;
    use super::IMockNativeTokenExt;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    #[abi(embed_v0)]
    impl ERC20MetadataImpl = ERC20Component::ERC20MetadataImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    impl ERC20Config of ERC20Component::ImmutableConfig {
        const DECIMALS: u8 = 18;
    }

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.erc20.initializer("Mock STRK", "mSTRK");
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockNativeTokenExt<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.erc20.mint(to, amount);
        }
    }
}

/// TEST ONLY. A Veil pool stand-in that can misbehave in every way the gateway
/// has to survive: pull and fill, revert, or accept the call and take nothing.
#[starknet::interface]
pub trait IMockPoolExt<TContractState> {
    /// 0 pull+fill, 1 revert, 2 accept but take nothing.
    fn set_mode(ref self: TContractState, mode: u8);
    fn filled(self: @TContractState, note_id: felt252) -> u128;
    fn calls(self: @TContractState) -> u32;
}

#[starknet::contract]
pub mod MockVeilPool {
    use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use veil_bridge::pool::IVeilPool;
    use super::IMockPoolExt;

    #[storage]
    struct Storage {
        mode: u8,
        calls: u32,
        notes: Map<felt252, u128>,
    }

    #[abi(embed_v0)]
    impl PoolImpl of IVeilPool<ContractState> {
        fn fill_open_note(
            ref self: ContractState, note_id: felt252, token: ContractAddress, amount: u128,
        ) {
            self.calls.write(self.calls.read() + 1);
            let mode = self.mode.read();
            assert(mode != 1, 'POOL_BOOM');
            if mode == 2 {
                return; // accepts the call, pulls nothing
            }
            // One-shot, as upstream.
            assert(self.notes.read(note_id) == 0, 'OPEN_NOTE_NOT_FILLABLE');
            self.notes.write(note_id, amount);
            IERC20Dispatcher { contract_address: token }
                .transfer_from(get_caller_address(), get_contract_address(), amount.into());
        }
    }

    #[abi(embed_v0)]
    impl ExtImpl of IMockPoolExt<ContractState> {
        fn set_mode(ref self: ContractState, mode: u8) {
            self.mode.write(mode);
        }
        fn filled(self: @ContractState, note_id: felt252) -> u128 {
            self.notes.read(note_id)
        }
        fn calls(self: @ContractState) -> u32 {
            self.calls.read()
        }
    }
}
