// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFaucetToken {
    function claimFor(address recipient) external returns (uint256);
}

/// One transaction that stocks a tester with every faucet asset.
///
/// An EOA cannot batch calls on Ethereum, so without this "get faucets" would
/// be one wallet prompt per asset -- five, to try a bridge that carries five.
/// The router calls `claimFor(recipient)` on each token instead.
///
/// It holds nothing, is owned by nobody, and mints to the RECIPIENT rather than
/// to itself, so there is no balance here to take and no privilege to capture.
contract FaucetRouter {
    event Claimed(address indexed recipient, address indexed token, uint256 amount);
    event Skipped(address indexed recipient, address indexed token);

    /// Claim every token that will have it, crediting `recipient`.
    ///
    /// A token that refuses -- cooldown not elapsed, faucet disabled, a
    /// compliance module blocking -- is SKIPPED, not reverted on. Otherwise one
    /// asset on cooldown would deny a tester the other four, which is exactly
    /// the case someone hits on their second visit.
    function claimAll(address[] calldata tokens, address recipient)
        external
        returns (uint256 claimed)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            // `try` does NOT cover this: Solidity emits an extcodesize check
            // before a call that expects a return value, and that reverts in
            // OUR frame, outside the catch. A mistyped address in the list
            // would take the whole batch down.
            if (tokens[i].code.length == 0) {
                emit Skipped(recipient, tokens[i]);
                continue;
            }
            try IFaucetToken(tokens[i]).claimFor(recipient) returns (uint256 amount) {
                emit Claimed(recipient, tokens[i], amount);
                claimed += 1;
            } catch {
                emit Skipped(recipient, tokens[i]);
            }
        }
    }
}
