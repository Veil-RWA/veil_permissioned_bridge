//! LayerZero V2 bridge for permissioned ERC-3643 assets.
//!
//! Escrow on an EVM chain, mint a permissioned twin here, mirror the source
//! chain's eligibility alongside the tokens, burn to release. See ../README.md.

pub mod bytes;
pub mod lz;
pub mod msg_codec;
pub mod mirrored_registry;
pub mod bridged_token;
pub mod gateway;
pub mod pool;
pub mod factory;

// T-REX compliance modules, restated as Cairo rules so an EVM token's rule set
// can be reproduced on its twin. See compliance/README or ../README.md.
pub mod compliance {
    pub mod rules;
}

// Test-only contracts. Under `src/` because snforge's `declare` resolves
// against the compiled starknet-contract target.
pub mod mocks;
