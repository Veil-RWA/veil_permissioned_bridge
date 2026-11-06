# VeilStellarLockbox (Soroban)

The Stellar end of the bridge for a **classic Stellar asset**, through its
Stellar Asset Contract (SAC). It is `evm/contracts/VeilLockboxBase.sol` +
`VeilAllowlistLockbox.sol` for a SAC:

- `bridge_out(from, amount, sn_recipient, note_id, pool, gas_limit, fee)`:
  `from` (a `G…` account) authorizes; the SAC transfer is the escrow; a MINT
  goes to the Starknet gateway with `from`'s raw Ed25519 key as the sender.
- `sync_compliance(account, payer, …)`: IDENTITY with `verified = SAC
  authorized(account)` and `frozen = !verified` (a revoked trustline
  authorization is the SAC's freeze). `sync_global` sends "not paused" (a SAC
  has no pause).
- `lz_receive` (UNLOCK from the gateway): pays the recipient key's account, or
  holds the amount in `claimable` if it is not authorized / has no trustline /
  the transfer fails. `claim(key)` retries. A release above the escrow reverts.

On Starknet the gateway is set to account format STELLAR
(`set_account_format(1)`) and the twin is an allowlisted asset. Peer EIDs:
Stellar 30600 mainnet / 40600 testnet, Starknet 30500 / 40500.

Issuer preconditions: with AUTH_REQUIRED the issuer must
`set_authorized(lockbox, true)`; with AUTH_CLAWBACK_ENABLED it can claw back the
escrow.

## Build and test

LayerZero's Soroban crates are not published; `./vendor.sh` vendors them into
`dependencies/` from LayerZero-Labs/monorepo-external at `LZ_COMMIT` (the flat
layout the monorepo's `build-utils-rust resolve` produces). Rust 1.90 and
`wasm32v1-none` come from `rust-toolchain.toml`.

    ./vendor.sh            # or LZ_MONOREPO=/path/to/checkout ./vendor.sh
    cargo test
    cargo build --release --target wasm32v1-none

The tests run against LayerZero's real EndpointV2 and SimpleMessageLib, a real
SAC, and `G…` accounts with trustlines.
