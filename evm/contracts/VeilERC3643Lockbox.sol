// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry, IERC3643} from "./interfaces/IERC3643.sol";
import {VeilLockboxBase} from "./VeilLockboxBase.sol";

/// The lockbox for an ERC-3643 (T-REX) token: eligibility is the token's own
/// identity registry, read live on every call.
///
/// The registry address is never stored. It is read from
/// `token.identityRegistry()` each time, so an issuer that points its token at
/// a new registry moves the bridge with it.
///
/// DEPLOYMENT PRECONDITION. T-REX `transferFrom` verifies the *recipient*, and
/// on a bridge-out this contract is the recipient. The issuer must therefore
/// register this lockbox as a verified identity in the token's registry before
/// any deposit can succeed -- the same precondition a Veil pool has.
contract VeilERC3643Lockbox is VeilLockboxBase {
    constructor(address endpoint_, address owner_, address token_, uint32 dstEid_)
        VeilLockboxBase(endpoint_, owner_, token_, dstEid_)
    {}

    function _registry() private view returns (IIdentityRegistry) {
        return IIdentityRegistry(IERC3643(address(token)).identityRegistry());
    }

    function _isEligible(address account) internal view override returns (bool) {
        return _registry().isVerified(account);
    }

    function _country(address account) internal view override returns (uint16) {
        return _registry().investorCountry(account);
    }
}
