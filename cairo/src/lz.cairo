// LayerZero V2 types and endpoint ABI, redeclared locally.
//
// These are structural copies of `layerzero::common::structs::*` and
// `layerzero::endpoint::interfaces::endpoint_v2` from
// `@layerzerolabs/protocol-starknet-v2` (read at v1.2.33). Field order, field
// types and function names are identical, so Serde lays them out the same way
// and the entrypoint selectors match — a dispatcher built from `IEndpointV2`
// here calls the real deployed endpoint correctly, and the real endpoint's
// `lz_receive` call lands on a contract that declares the same signature.
//
// Why redeclare instead of depending on the package: see the header of
// `bytes.cairo`. The dependency is a toolchain-version conflict, not a
// correctness one, and the ABI is small and stable enough to pin by hand.
//
// Deployed endpoints (LayerZero metadata API, verified 2026-09):
//   Starknet mainnet  eid 30500  0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68
//   Starknet sepolia  eid 40500  0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878
//   Ethereum mainnet  eid 30101  0x1a44076050125825900e736c501f859c50fe728c
//   Ethereum sepolia  eid 40161  0x6edce65403992e310a62460808c4b910d972f10f

use starknet::ContractAddress;
use super::bytes::{append_u8, append_u16, append_u128};

/// LayerZero's 32-byte address word. Starknet addresses convert directly;
/// EVM addresses are the 20-byte value left-padded to 32.
#[derive(Copy, Drop, Serde, PartialEq, Debug, Default, starknet::Store)]
pub struct Bytes32 {
    pub value: u256,
}

pub impl ContractAddressIntoBytes32 of Into<ContractAddress, Bytes32> {
    fn into(self: ContractAddress) -> Bytes32 {
        let as_felt: felt252 = self.into();
        Bytes32 { value: as_felt.into() }
    }
}

/// Provenance of an inbound message, as the endpoint reports it.
#[derive(Copy, Drop, Serde, PartialEq, Debug, Default)]
pub struct Origin {
    pub src_eid: u32,
    pub sender: Bytes32,
    pub nonce: u64,
}

#[derive(Drop, Serde, Clone, PartialEq, Debug, Default)]
pub struct MessagingParams {
    pub dst_eid: u32,
    pub receiver: Bytes32,
    pub message: ByteArray,
    pub options: ByteArray,
    pub pay_in_lz_token: bool,
}

#[derive(Copy, Drop, Serde, Default, PartialEq, Debug)]
pub struct MessagingFee {
    pub native_fee: u256,
    pub lz_token_fee: u256,
}

#[derive(Drop, Clone, Serde, PartialEq, Debug)]
pub struct Payee {
    pub receiver: ContractAddress,
    pub native_amount: u256,
    pub lz_token_amount: u256,
}

#[derive(Drop, Serde, Default, PartialEq, Debug)]
pub struct MessageReceipt {
    pub guid: Bytes32,
    pub nonce: u64,
    pub payees: Array<Payee>,
}

#[starknet::interface]
pub trait IEndpointV2<TContractState> {
    fn send(
        ref self: TContractState, params: MessagingParams, refund_address: ContractAddress,
    ) -> MessageReceipt;
    fn quote(
        self: @TContractState, params: MessagingParams, sender: ContractAddress,
    ) -> MessagingFee;
    fn set_delegate(ref self: TContractState, delegate: ContractAddress);
}

/// The receiver surface the endpoint drives. `OAppCoreComponent` embeds exactly
/// this; the gateway implements it inline so it can run the peer check and the
/// message dispatch in one place.
#[starknet::interface]
pub trait ILayerZeroReceiver<TContractState> {
    fn lz_receive(
        ref self: TContractState,
        origin: Origin,
        guid: Bytes32,
        message: ByteArray,
        executor: ContractAddress,
        extra_data: ByteArray,
        value: u256,
    );
    fn allow_initialize_path(self: @TContractState, origin: Origin) -> bool;
    fn next_nonce(self: @TContractState, src_eid: u32, sender: Bytes32) -> u64;
}

/// Type-3 executor options carrying a single `lzReceive` gas limit.
///
/// Layout, matching the encoder in LayerZero's Starknet docs:
///   u16  3   options type
///   u8   1   executor worker id
///   u16  n   length of the option body, including its type byte
///   u8   1   lzReceive option
///   u128 g   gas limit
pub fn build_lz_receive_options(gas_limit: u128) -> ByteArray {
    let mut params: ByteArray = Default::default();
    append_u128(ref params, gas_limit);

    let mut options: ByteArray = Default::default();
    append_u16(ref options, 3);
    append_u8(ref options, 1);
    let body_len: u16 = (params.len() + 1).try_into().unwrap();
    append_u16(ref options, body_len);
    append_u8(ref options, 1);
    options.append(@params);
    options
}
