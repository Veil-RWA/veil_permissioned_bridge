//! The bridge wire format (cairo/src/msg_codec.cairo, evm BridgeMsgCodec.sol):
//! big-endian, no padding. Every account word is a Stellar account's raw
//! 32-byte Ed25519 key.
//!
//!   MINT      1 kind=1 | 32 sender key | 32 sn_recipient | 32 amount (u256) | 8 seq
//!             | 1 verified | 1 frozen | 2 country | 32 note_id | 32 pool   = 173
//!   IDENTITY  1 kind=2 | 32 key | 8 seq | 1 verified | 1 frozen | 2 country = 45
//!   GLOBAL    1 kind=3 | 8 seq | 1 paused                                    = 10
//!   UNLOCK    1 kind=4 | 32 recipient key | 32 amount (u256)                 = 65

use soroban_sdk::{Bytes, BytesN, Env};

pub const KIND_MINT: u8 = 1;
pub const KIND_IDENTITY: u8 = 2;
pub const KIND_GLOBAL: u8 = 3;
pub const KIND_UNLOCK: u8 = 4;

fn push_u256_from_i128(out: &mut Bytes, v: i128) {
    // Non-negative amounts only (checked by the callers).
    out.extend_from_array(&[0u8; 16]);
    out.extend_from_array(&(v as u128).to_be_bytes());
}

#[allow(clippy::too_many_arguments)]
pub fn encode_mint(
    env: &Env,
    sender: &BytesN<32>,
    sn_recipient: &BytesN<32>,
    amount: i128,
    seq: u64,
    verified: bool,
    frozen: bool,
    note_id: &BytesN<32>,
    pool: &BytesN<32>,
) -> Bytes {
    let mut out = Bytes::new(env);
    out.push_back(KIND_MINT);
    out.append(&sender.clone().into());
    out.append(&sn_recipient.clone().into());
    push_u256_from_i128(&mut out, amount);
    out.extend_from_array(&seq.to_be_bytes());
    out.push_back(verified as u8);
    out.push_back(frozen as u8);
    out.extend_from_array(&0u16.to_be_bytes());
    out.append(&note_id.clone().into());
    out.append(&pool.clone().into());
    out
}

pub fn encode_identity(env: &Env, account: &BytesN<32>, seq: u64, verified: bool, frozen: bool) -> Bytes {
    let mut out = Bytes::new(env);
    out.push_back(KIND_IDENTITY);
    out.append(&account.clone().into());
    out.extend_from_array(&seq.to_be_bytes());
    out.push_back(verified as u8);
    out.push_back(frozen as u8);
    out.extend_from_array(&0u16.to_be_bytes());
    out
}

pub fn encode_global(env: &Env, seq: u64, paused: bool) -> Bytes {
    let mut out = Bytes::new(env);
    out.push_back(KIND_GLOBAL);
    out.extend_from_array(&seq.to_be_bytes());
    out.push_back(paused as u8);
    out
}

pub fn encode_unlock(env: &Env, recipient: &BytesN<32>, amount: i128) -> Bytes {
    let mut out = Bytes::new(env);
    out.push_back(KIND_UNLOCK);
    out.append(&recipient.clone().into());
    push_u256_from_i128(&mut out, amount);
    out
}

/// UNLOCK -> (recipient key, amount). None if it is not a well-formed UNLOCK
/// or the amount does not fit an i128.
pub fn decode_unlock(env: &Env, message: &Bytes) -> Option<(BytesN<32>, i128)> {
    if message.len() != 65 || message.get(0)? != KIND_UNLOCK {
        return None;
    }
    let recipient: BytesN<32> = message.slice(1..33).try_into().ok()?;
    let mut amount = [0u8; 32];
    message.slice(33..65).copy_into_slice(&mut amount);
    if amount[..16].iter().any(|b| *b != 0) {
        return None;
    }
    let mut low = [0u8; 16];
    low.copy_from_slice(&amount[16..]);
    let v = u128::from_be_bytes(low);
    if v > i128::MAX as u128 {
        return None;
    }
    let _ = env;
    Some((recipient, v as i128))
}

/// Whether a 32-byte word is below 2^251, so the Starknet side reads it as a
/// felt / address instead of reverting (a stuck message, escrow stranded).
pub fn fits_felt(word: &BytesN<32>) -> bool {
    word.get(0).unwrap_or(0xff) < 0x08
}
