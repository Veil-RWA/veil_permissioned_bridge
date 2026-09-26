// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Circle CCTP V2 `TokenMessengerV2` (circlefin/evm-cctp-contracts,
/// src/v2/TokenMessengerV2.sol), the one function the cash leg calls.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

interface IUSDCApprove {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The cash leg (USDC) into a Veil pool on Starknet, from the holder's wallet.
///
/// No Veil contract on this chain: the wallet burns through Circle's CCTP
/// directly, naming the pool's `VeilCashVault` on Starknet as BOTH the mint
/// recipient and the destination caller, and the holder's empty USDC open note
/// as the hook data. Only the vault can then relay the message, and it fills
/// that note in the same call. Public on this chain: the wallet, the amount and
/// the note id. Not public anywhere: which Starknet account owns the note.
///
/// `internal`, so it runs inside the calling contract: the wallet that burns is
/// the one a refund returns to if the note cannot take the deposit.
library VeilCash {
    /// Circle's CCTP domain for Starknet.
    uint32 internal constant STARKNET_DOMAIN = 25;
    /// Standard Transfer: attested at finality, no CCTP fee (pass maxFee 0).
    uint32 internal constant STANDARD_FINALITY = 2000;
    /// Fast Transfer: attested before finality, for a fee up to `maxFee`.
    uint32 internal constant FAST_FINALITY = 1000;

    error ZeroNote();
    error ZeroVault();
    error ApproveFailed();

    /// Burn `amount` of this contract's USDC into `noteId` in the Veil pool
    /// that `vault` serves. `vault` and `noteId` come from Veil.
    function toVeil(
        ITokenMessengerV2 messenger,
        address usdc,
        uint256 amount,
        bytes32 vault,
        bytes32 noteId,
        uint256 maxFee,
        uint32 minFinality
    ) internal {
        if (noteId == bytes32(0)) revert ZeroNote();
        if (vault == bytes32(0)) revert ZeroVault();
        // Exact allowance; the messenger's transferFrom consumes it.
        if (!IUSDCApprove(usdc).approve(address(messenger), amount)) revert ApproveFailed();
        messenger.depositForBurnWithHook(
            amount, STARKNET_DOMAIN, vault, usdc, vault, maxFee, minFinality, abi.encode(noteId)
        );
    }
}
