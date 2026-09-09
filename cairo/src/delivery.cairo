// Where a bridge-in lands on Starknet.
//
// Minting to the recipient's wallet is the default and the fallback. It is
// simple and always available, but it is a PUBLIC balance -- which is the wrong
// destination for an asset whose whole point is confidential settlement.
//
// The alternative is to hand the amount to a delivery adapter, which fills the
// recipient's open note in a Veil pool so the position arrives private. The
// adapter is deliberately the only thing this repo knows about that pool: one
// entrypoint, declared here, implemented elsewhere. The bridge takes no
// dependency on the pool's internals, cannot be broken by a change to them, and
// works unchanged with no adapter configured at all.
//
// The contract with an adapter, which the gateway enforces rather than trusts:
//
//   * it PULLS. The gateway holds the freshly minted tokens and approves the
//     adapter for exactly `amount`; the adapter must `transfer_from` to take
//     them. It is never handed tokens up front, so an adapter that reverts,
//     declines or does nothing leaves the balance with the gateway, which
//     sweeps it to the recipient. Pushing first would let a broken adapter keep
//     the funds.
//   * it may fail. A revert, a `false`, or a silent no-op all degrade to the
//     wallet path. A bridge-in must never be lost because a downstream pool
//     was paused, un-whitelisted, or had no open note to fill.
//   * to receive the twin it must itself be a verified identity in the mirror,
//     exactly as a Veil pool must be. If it is not, its pull reverts and the
//     transfer degrades to the wallet -- which is the correct outcome.
//   * it is set by the owner, so it is trusted for correctness -- but the pull
//     model and the sweep mean even a broken one cannot strand funds.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IVeilDeliveryAdapter<TContractState> {
    /// Take `amount` of `token` from the caller (the gateway has approved you
    /// for exactly this) and fill `note_id` on behalf of `recipient`. Return
    /// false to decline without pulling; the gateway then sends the amount to
    /// the recipient's wallet instead.
    fn deliver(
        ref self: TContractState,
        token: ContractAddress,
        recipient: ContractAddress,
        amount: u256,
        note_id: felt252,
    ) -> bool;
}
