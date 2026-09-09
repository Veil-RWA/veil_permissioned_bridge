// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry, ICompliance, IERC20Like, IERC3643} from "./interfaces/IERC3643.sol";

/// The extra T-REX members the bridge reads beyond what the pool needs.
///
/// Declared here rather than added to `interfaces/IERC3643.sol` so the audited
/// pool surface stays exactly as trimmed. Both are called through `staticcall`
/// with a fallback, never as a hard dependency: `isFrozen` and `paused` are
/// standard in T-REX but a given issuer's deployment may not expose them, and a
/// bridge that reverts because an optional getter is missing is worse than one
/// that treats the answer as unknown.
interface IERC3643Optional {
    function isFrozen(address account) external view returns (bool);
    function paused() external view returns (bool);
}
