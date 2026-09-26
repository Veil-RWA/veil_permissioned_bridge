// What the cash leg talks to on Starknet that it does not own: Circle's CCTP
// V2 and the Veil pool. Restated, not imported, like the rest of the bridge.
//
// CCTP is copied from Circle's `circlefin/starknet-cctp`
// (`packages/interfaces/src/token_messager_minter_v2.cairo`,
// `message_transmitter_v2.cairo`); the byte offsets are Circle's
// (`packages/message/src/message_v2.cairo`, `burn_message_v2.cairo`), identical
// on every CCTP chain. The pool surface is a structural copy of
// `veil::interfaces::IVeilERC3643` (names, argument order and types must match;
// the tests run against the real pool, so a drift fails there).

use starknet::ContractAddress;

/// Circle CCTP domains.
pub const ETHEREUM_DOMAIN: u32 = 0;
pub const STARKNET_DOMAIN: u32 = 25;

/// CCTP V2 finality thresholds: 2000 = Standard Transfer (finalized, free on
/// every route today), 1000 = Fast Transfer (a fee, `max_fee`).
pub const STANDARD_FINALITY: u32 = 2000;

// CCTP V2 message layout.
pub const SOURCE_DOMAIN_INDEX: u32 = 4;
pub const NONCE_INDEX: u32 = 12;
pub const DESTINATION_CALLER_INDEX: u32 = 108;
pub const MESSAGE_BODY_INDEX: u32 = 148;
// Burn message body, from the start of the message.
pub const MINT_RECIPIENT_INDEX: u32 = MESSAGE_BODY_INDEX + 36;
pub const AMOUNT_INDEX: u32 = MESSAGE_BODY_INDEX + 68;
pub const MESSAGE_SENDER_INDEX: u32 = MESSAGE_BODY_INDEX + 100;
pub const FEE_EXECUTED_INDEX: u32 = MESSAGE_BODY_INDEX + 164;
pub const HOOK_DATA_INDEX: u32 = MESSAGE_BODY_INDEX + 228;

/// An empty open note in the pool: salt 1 in the high 128 bits, amount 0.
pub const EMPTY_OPEN_NOTE: felt252 = 0x100000000000000000000000000000000;

/// `TokenMessengerMinterV2` (burn side).
#[starknet::interface]
pub trait ITokenMessengerMinterV2<TContractState> {
    fn deposit_for_burn(
        ref self: TContractState,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
    );
    fn deposit_for_burn_with_hook(
        ref self: TContractState,
        amount: u256,
        destination_domain: u32,
        mint_recipient: u256,
        burn_token: ContractAddress,
        destination_caller: u256,
        max_fee: u256,
        min_finality_threshold: u32,
        hook_data: ByteArray,
    );
}

/// `MessageTransmitterV2` (receive side).
#[starknet::interface]
pub trait IMessageTransmitterV2<TContractState> {
    fn receive_message(ref self: TContractState, message: ByteArray, attestation: ByteArray) -> bool;
}

#[starknet::interface]
pub trait ICashERC20<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

#[derive(Copy, Drop, Serde)]
pub struct OpenNoteRecord {
    pub token: ContractAddress,
}

#[derive(Copy, Drop, Serde)]
pub struct NoteRecord {
    pub encrypted_amount: felt252,
}

/// The pool, as the cash leg sees it.
#[starknet::interface]
pub trait IVeilCashPool<TContractState> {
    fn fill_open_note(
        ref self: TContractState, note_id: felt252, token: ContractAddress, amount: u128,
    );
    fn get_open_note(self: @TContractState, note_id: felt252) -> OpenNoteRecord;
    fn get_notes_batch(self: @TContractState, note_ids: Array<felt252>) -> Array<NoteRecord>;
}

/// `privacy::objects::OpenNoteDeposit`: what an invoked adapter returns for the
/// pool to pull into the invoke's open note.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

/// A Starknet address as CCTP's 32-byte word.
pub fn word_of(address: ContractAddress) -> u256 {
    let f: felt252 = address.into();
    f.into()
}
