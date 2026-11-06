//! The Stellar end of the Veil permissioned bridge: `VeilStellarLockbox`, a
//! LayerZero V2 OApp on Soroban that escrows a classic Stellar asset through its
//! Stellar Asset Contract (SAC) and drives the asset's twin on Starknet.
//!
//! It is `evm/contracts/VeilLockboxBase.sol` + `VeilAllowlistLockbox.sol` for a
//! SAC. Eligibility is the SAC's own `authorized(id)` (the issuer's
//! AUTH_REQUIRED / AUTH_REVOCABLE trustline flag), so on Starknet the twin is
//! an allowlisted asset whose mirror is fed IDENTITY records. Messages use the
//! bridge's wire format (cairo/src/msg_codec.cairo) with every account word a
//! Stellar account's raw Ed25519 key; the Starknet gateway is set to account
//! format STELLAR.
#![no_std]

pub mod codec;
pub mod errors;
pub mod lockbox;
mod options;
mod storage;

#[cfg(test)]
mod tests;
