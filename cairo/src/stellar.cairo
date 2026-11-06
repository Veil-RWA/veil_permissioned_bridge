// Stellar holders on the bridge (a gateway whose lockbox is on Stellar).
//
// The Stellar lockbox names accounts by their raw Ed25519 key (32 bytes, the
// key inside a `G…` StrKey). The Veil pool's holder for that key is
//
//   stellar_holder(pk) = 2^249 + (poseidon('VEIL_STELLAR_HOLDER', pk.high, pk.low) mod 2^249)
//
// exactly as veil's src/helpers/stellar_signature.cairo computes it (this
// package links nothing from `veil`; tests/test_stellar_holder.cairo pins the
// two together). The mirror's identity for a Stellar account is that holder
// felt, so a Stellar wallet holding as itself is bound to itself, as an EVM
// wallet is.
//
// Signatures are checked by veil's VeilStellarVerifier class, reached with a
// library call by the class hash the gateway owner sets (as the pool does), so
// the Ed25519 code is not duplicated here.

use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use starknet::syscalls::get_class_hash_at_syscall;
use starknet::{ContractAddress, SyscallResultTrait};

/// The gateway's lockbox names accounts as 20-byte EVM addresses.
pub const ACCOUNT_FORMAT_EVM: u8 = 0;
/// The gateway's lockbox names accounts as 32-byte Ed25519 keys (Stellar).
pub const ACCOUNT_FORMAT_STELLAR: u8 = 1;

pub const TWO_POW_249: u256 = 0x200000000000000000000000000000000000000000000000000000000000000;
const TWO_POW_249_NZ: NonZero<u256> = 0x200000000000000000000000000000000000000000000000000000000000000;
const STELLAR_HOLDER_TAG: felt252 = 'VEIL_STELLAR_HOLDER';
const STELLAR_RECIPIENT_TAG: felt252 = 'VEIL_STELLAR_RECIPIENT';

/// The Veil holder for the Ed25519 key `pk` (its 32 bytes, big-endian).
pub fn stellar_holder(pk: u256) -> ContractAddress {
    let h: felt252 = poseidon_hash_span(
        array![STELLAR_HOLDER_TAG, pk.high.into(), pk.low.into()].span(),
    );
    let h: u256 = h.into();
    let (_, low) = DivRem::div_rem(h, TWO_POW_249_NZ);
    let a: felt252 = (TWO_POW_249 + low).try_into().unwrap();
    a.try_into().unwrap()
}

/// A holder that signs as a Stellar wallet: at or above 2^249, no class.
pub fn is_stellar_wallet(account: ContractAddress) -> bool {
    let a: felt252 = account.into();
    let a: u256 = a.into();
    if a < TWO_POW_249 {
        return false;
    }
    get_class_hash_at_syscall(account).unwrap_syscall().is_zero()
}

/// The felt that names a Stellar exit recipient in a pool `invoke`'s calldata
/// (a 32-byte key does not fit the felt the exit takes). Collision resistant,
/// so the holder's signature over the calldata binds the key.
pub fn recipient_handle(pk: u256) -> felt252 {
    poseidon_hash_span(array![STELLAR_RECIPIENT_TAG, pk.high.into(), pk.low.into()].span())
}
