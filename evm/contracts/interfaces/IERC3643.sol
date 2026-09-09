// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal T-REX surface the pool depends on.
interface IIdentityRegistry {
    function isVerified(address account) external view returns (bool);
    function investorCountry(address account) external view returns (uint16);
}

interface ICompliance {
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
}

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC3643 is IERC20Like {
    function identityRegistry() external view returns (address);
    function compliance() external view returns (address);
}
