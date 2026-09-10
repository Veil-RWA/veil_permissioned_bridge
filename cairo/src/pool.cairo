// The Veil pool, as the bridge needs to see it.
//
// One entrypoint. The bridge takes no dependency on the pool's internals, and
// nothing here changes when they do.
//
// `fill_open_note` writes an empty open note from (salt=1, amount=0) to
// (salt=1, amount) and pulls the tokens with `transfer_from(caller -> pool)`.
// Three consequences the gateway has to respect:
//
//   * the CALLER supplies the tokens, so the gateway must hold them and approve
//     the pool before calling;
//   * the caller must be on the pool's `allowed_adapters` list, granted by the
//     pool owner. Until that is done every pool-bound transfer lands in the
//     recipient's wallet instead;
//   * `amount` is u128. The twin's balances are u256, so anything at or above
//     2^128 cannot be delivered to a note and must not be attempted.
//
// The fill is ONE-SHOT: a note that has been filled cannot be filled again.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IVeilPool<TContractState> {
    fn fill_open_note(
        ref self: TContractState, note_id: felt252, token: ContractAddress, amount: u128,
    );
}
