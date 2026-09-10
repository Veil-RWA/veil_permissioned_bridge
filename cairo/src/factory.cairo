// The VeilERC3643Factory, as the bridge needs to see it.
//
// A Veil pool is MULTI-ASSET: one pool carries any number of ERC-3643 tokens,
// so "which pool" is a choice the holder makes, not something the asset
// implies. Most holders want the main pool; an entity that runs its own pool
// wants that one instead.
//
// Letting the message name a pool means the gateway would otherwise call
// whatever address a peer put on the wire. The factory is what makes that safe
// without an operator allowlist: `create_pool` is the only way a Veil pool
// comes into existence, and it records the deployer in `pool_owner`. So a
// non-zero owner is proof the address is a genuine pool this factory deployed,
// and the check stays permissionless -- a pool created a minute ago passes,
// with nobody having to add it to a list.
//
// An address that is not a pool reads back as zero rather than reverting, so
// the check costs one call and never needs to trust the address it is asking
// about.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IVeilFactory<TContractState> {
    fn get_pool_owner(self: @TContractState, pool: ContractAddress) -> ContractAddress;
}
