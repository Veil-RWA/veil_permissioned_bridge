//! LayerZero V2 bridge for permissioned assets: ERC-3643, allowlisted ERC-20
//! and rule-gated ERC-20.
//!
//! Escrow on an EVM chain, mint a permissioned twin here, mirror the source
//! chain's eligibility alongside the tokens, burn to release. See ../README.md.

pub mod bytes;
pub mod lz;
pub mod msg_codec;
pub mod mirrored_registry;
// A rule-gated asset's transfer rules, answering the Veil pool's ITransferRules.
pub mod mirrored_rules;
pub mod bridged_token;
pub mod gateway;
pub mod pool;
pub mod factory;

// The cash leg (USDC) over Circle's CCTP, into and out of a Veil pool without
// naming the holder: the same pattern as HyperVeil's entry helper and exit vault.
pub mod cash_cctp;
pub mod cash_vault;
pub mod cash_exit;
pub mod cash_rules;

// T-REX compliance modules, restated as Cairo rules so an EVM token's rule set
// can be reproduced on its twin. See compliance/README or ../README.md.
pub mod compliance {
    pub mod rules;
}

// Test-only contracts. Under `src/` because snforge's `declare` resolves
// against the compiled starknet-contract target.
pub mod mocks;
pub mod cash_mocks;
