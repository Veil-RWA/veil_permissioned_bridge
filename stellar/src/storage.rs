use common_macros::storage;
use soroban_sdk::{Address, BytesN};

#[storage]
pub enum LockboxStorage {
    /// The SAC of the escrowed asset.
    #[instance(Address)]
    Token,

    /// Endpoint id of the Starknet deployment (30500 mainnet, 40500 sepolia).
    #[instance(u32)]
    DstEid,

    /// Strictly increasing across every per-account message (MINT, IDENTITY),
    /// as the EVM lockbox's `seq`: the mirror drops records that are not newer.
    #[instance(u64)]
    #[default(0)]
    Seq,

    #[instance(u64)]
    #[default(0)]
    GlobalSeq,

    /// Escrow released to an account that could not receive it when the
    /// release arrived, keyed by its Ed25519 key. Held, not lost.
    #[persistent(i128)]
    #[default(0)]
    Claimable { account: BytesN<32> },

    #[instance(i128)]
    #[default(0)]
    TotalClaimable,

    /// Tokens held against twin supply on Starknet.
    #[instance(i128)]
    #[default(0)]
    TotalEscrowed,
}
