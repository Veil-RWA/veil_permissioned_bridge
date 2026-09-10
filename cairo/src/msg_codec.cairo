// Wire format shared with evm/contracts/bridge/BridgeMsgCodec.sol.
//
// Both sides pack fields big-endian with no padding, so the layouts below are
// the single source of truth for the bridge. Any change here needs the same
// change in the Solidity codec, and `tests/test_bridge.cairo` pins the byte
// layout with fixed vectors so a one-sided edit fails loudly instead of
// silently misreading amounts.
//
//   MINT (EVM -> Starknet), 174 bytes
//     0    u8    kind = 1
//     1    b32   evm_sender          20-byte address, left-padded
//     33   b32   sn_recipient        Starknet address as a felt
//     65   u256  amount
//     97   u64   seq                 source-assigned, monotonic
//     105  u8    verified
//     106  u8    frozen
//     107  u16   country             ISO-3166 numeric
//     109  u8    delivery            0 = wallet, 1 = Veil pool open note
//     110  b32   note_id             0 unless delivery = 1
//     142  b32   pool                0 = the gateway's default Veil pool
//
//   WALLET mints to the recipient's Starknet address. POOL fills the
//   recipient's open note so the position arrives in the pool rather than as a
//   public balance. POOL degrades to WALLET rather than failing -- see the
//   gateway.
//
//   A Veil pool is MULTI-ASSET: one pool carries any number of tokens, so the
//   pool named here is not implied by the asset. Zero means the gateway's
//   configured default -- the main Veil pool. A non-zero value lets a holder
//   send to an entity's own pool instead, and the gateway checks it against the
//   VeilERC3643Factory before touching it.
//
//   IDENTITY (EVM -> Starknet), 45 bytes
//     0    u8    kind = 2
//     1    b32   evm_account
//     33   u64   seq
//     41   u8    verified
//     42   u8    frozen
//     43   u16   country
//
//   GLOBAL (EVM -> Starknet), 10 bytes
//     0    u8    kind = 3
//     1    u64   seq
//     9    u8    paused
//
//   GLOBAL carries only token STATE. Compliance RULE parameters (holding caps,
//   supply limits, country lists) are not synced here: they are replicated once
//   at allowance time into `MirroredCompliance`, which is their single home.
//
//   UNLOCK (Starknet -> EVM), 65 bytes
//     0    u8    kind = 4
//     1    b32   evm_recipient
//     33   u256  amount
//
// A MINT carries the sender's compliance snapshot alongside the transfer so a
// bridge-in is always accompanied by fresh eligibility data — the mirror never
// has to mint against a record it has never seen.

use super::bytes::{
    append_bool, append_u16, append_u256, append_u64, append_u8, read_bool, read_u16, read_u256,
    read_u64, read_u8,
};

pub const KIND_MINT: u8 = 1;
pub const KIND_IDENTITY: u8 = 2;
pub const KIND_GLOBAL: u8 = 3;
pub const KIND_UNLOCK: u8 = 4;

/// Where a bridge-in should land.
pub const DELIVERY_WALLET: u8 = 0;
pub const DELIVERY_POOL: u8 = 1;

/// 2^160: one past the largest EVM address.
pub const EVM_ADDRESS_BOUND: u256 = 0x10000000000000000000000000000000000000000;

/// The per-account compliance snapshot both MINT and IDENTITY carry.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct IdentitySnapshot {
    /// EVM address the source registry actually made its decision about.
    pub evm_account: felt252,
    pub seq: u64,
    pub verified: bool,
    pub frozen: bool,
    pub country: u16,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct MintMessage {
    pub identity: IdentitySnapshot,
    pub sn_recipient: starknet::ContractAddress,
    pub amount: u256,
    pub delivery: u8,
    pub note_id: felt252,
    /// Zero selects the gateway's default pool.
    pub pool: starknet::ContractAddress,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct GlobalMessage {
    pub seq: u64,
    pub paused: bool,
}

pub fn kind(message: @ByteArray) -> u8 {
    read_u8(message, 0)
}

/// Narrow a 32-byte word to an EVM address. Rejects anything with dirty high
/// bytes rather than truncating, so a malformed peer message cannot be made to
/// alias a different account.
fn word_to_evm_address(word: u256) -> felt252 {
    assert(word < EVM_ADDRESS_BOUND, 'BRIDGE_BAD_EVM_ADDR');
    word.try_into().expect('BRIDGE_BAD_EVM_ADDR')
}

fn word_to_starknet_address(word: u256) -> starknet::ContractAddress {
    let as_felt: felt252 = word.try_into().expect('BRIDGE_BAD_SN_ADDR');
    as_felt.try_into().expect('BRIDGE_BAD_SN_ADDR')
}

pub fn decode_mint(message: @ByteArray) -> MintMessage {
    assert(read_u8(message, 0) == KIND_MINT, 'BRIDGE_KIND_MISMATCH');
    MintMessage {
        identity: IdentitySnapshot {
            evm_account: word_to_evm_address(read_u256(message, 1)),
            seq: read_u64(message, 97),
            verified: read_bool(message, 105),
            frozen: read_bool(message, 106),
            country: read_u16(message, 107),
        },
        sn_recipient: word_to_starknet_address(read_u256(message, 33)),
        amount: read_u256(message, 65),
        delivery: read_u8(message, 109),
        note_id: read_u256(message, 110).try_into().expect('BRIDGE_BAD_NOTE_ID'),
        pool: word_to_starknet_address(read_u256(message, 142)),
    }
}

pub fn decode_identity(message: @ByteArray) -> IdentitySnapshot {
    assert(read_u8(message, 0) == KIND_IDENTITY, 'BRIDGE_KIND_MISMATCH');
    IdentitySnapshot {
        evm_account: word_to_evm_address(read_u256(message, 1)),
        seq: read_u64(message, 33),
        verified: read_bool(message, 41),
        frozen: read_bool(message, 42),
        country: read_u16(message, 43),
    }
}

pub fn decode_global(message: @ByteArray) -> GlobalMessage {
    assert(read_u8(message, 0) == KIND_GLOBAL, 'BRIDGE_KIND_MISMATCH');
    GlobalMessage { seq: read_u64(message, 1), paused: read_bool(message, 9) }
}

/// Built on Starknet, consumed by the lockbox's `_lzReceive`.
pub fn encode_unlock(evm_recipient: felt252, amount: u256) -> ByteArray {
    let recipient_word: u256 = evm_recipient.into();
    assert(recipient_word < EVM_ADDRESS_BOUND, 'BRIDGE_BAD_EVM_ADDR');

    let mut out: ByteArray = Default::default();
    append_u8(ref out, KIND_UNLOCK);
    append_u256(ref out, recipient_word);
    append_u256(ref out, amount);
    out
}

// ── Encoders for the inbound kinds ───────────────────────────────────────────
// Production traffic for these is built by the Solidity lockbox; these exist so
// the Cairo tests can construct byte-exact payloads (and so the layout above is
// asserted from both directions).

pub fn encode_mint(msg: MintMessage) -> ByteArray {
    let mut out: ByteArray = Default::default();
    append_u8(ref out, KIND_MINT);
    append_u256(ref out, msg.identity.evm_account.into());
    let recipient: felt252 = msg.sn_recipient.into();
    append_u256(ref out, recipient.into());
    append_u256(ref out, msg.amount);
    append_u64(ref out, msg.identity.seq);
    append_bool(ref out, msg.identity.verified);
    append_bool(ref out, msg.identity.frozen);
    append_u16(ref out, msg.identity.country);
    append_u8(ref out, msg.delivery);
    append_u256(ref out, msg.note_id.into());
    append_u256(ref out, Into::<_, felt252>::into(msg.pool).into());
    out
}

pub fn encode_identity(snapshot: IdentitySnapshot) -> ByteArray {
    let mut out: ByteArray = Default::default();
    append_u8(ref out, KIND_IDENTITY);
    append_u256(ref out, snapshot.evm_account.into());
    append_u64(ref out, snapshot.seq);
    append_bool(ref out, snapshot.verified);
    append_bool(ref out, snapshot.frozen);
    append_u16(ref out, snapshot.country);
    out
}

pub fn encode_global(msg: GlobalMessage) -> ByteArray {
    let mut out: ByteArray = Default::default();
    append_u8(ref out, KIND_GLOBAL);
    append_u64(ref out, msg.seq);
    append_bool(ref out, msg.paused);
    out
}
