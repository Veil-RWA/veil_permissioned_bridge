// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VeilLockboxBase} from "./VeilLockboxBase.sol";

/// The issuer's allowlist, in the shape OpenZeppelin's AccessControl gives it:
/// an account is allowed when it holds `role`. An issuer whose list has another
/// shape (`isAllowed(address)`, `isWhitelisted(address)`) points the lockbox at
/// a small adapter that answers `hasRole` from it.
interface IAllowlist {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// The lockbox for an allowlisted ERC-20: a plain ERC-20 whose own transfer
/// check requires both sender and recipient to be on the issuer's allowlist.
///
/// Eligibility is membership of that list, read live on every call. The list
/// keeps no country, so none is sent. Freeze and pause come from the token's
/// optional `isFrozen` and `paused`, read defensively, as for every kind.
///
/// On Starknet the twin is listed in the Veil pool as an allowlisted token, so
/// the pool applies the same rule inside every proof: sender and recipient
/// both allowed, and the token not paused.
///
/// DEPLOYMENT PRECONDITION. The token checks the recipient of every transfer,
/// and on a bridge-out this contract is the recipient: the issuer must add this
/// lockbox to the allowlist before any deposit can succeed.
contract VeilAllowlistLockbox is VeilLockboxBase {
    /// The contract that holds the allowlist.
    IAllowlist public immutable allowlist;
    /// The role an account must hold to be allowed.
    bytes32 public immutable role;

    constructor(
        address endpoint_,
        address owner_,
        address token_,
        uint32 dstEid_,
        address allowlist_,
        bytes32 role_
    ) VeilLockboxBase(endpoint_, owner_, token_, dstEid_) {
        if (allowlist_ == address(0)) revert ZeroAddress();
        allowlist = IAllowlist(allowlist_);
        role = role_;
    }

    function _isEligible(address account) internal view override returns (bool) {
        return allowlist.hasRole(role, account);
    }
}
