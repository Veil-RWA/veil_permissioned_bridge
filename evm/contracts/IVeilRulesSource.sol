// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// An issuer's transfer rules for a rule-gated ERC-20, as the bridge carries
/// them to Starknet.
///
/// A rule-gated token decides each transfer with the issuer's own rules engine.
/// Inside a Veil pool movements are private, so the token cannot be asked; the
/// pool applies the same rules itself, inside every proof, from records this
/// adapter answers and the lockbox mirrors. The adapter is written by the
/// issuer (or for it) and must answer from the SAME data the token's own check
/// uses -- it states the rules, it does not add to them.
///
/// The rule set is parametric: any issuer whose rules can be expressed in these
/// terms can bridge. Each field maps one-for-one to a question the Veil pool
/// asks inside its proofs (`ITransferRules` on Starknet).
interface IVeilRulesSource {
    struct HolderRules {
        /// May the account hold the token (approved, KYC'd, member; not banned)?
        bool canHold;
        /// Has the issuer frozen the account?
        bool frozen;
        /// Does the account already count as an investor toward the issuer's
        /// investor cap?
        bool isInvestor;
        /// How much of the account's balance the issuer locks right now (a
        /// lock-up, a transfer-agent lock) that its balance on this chain does
        /// not already cover. The pool keeps at least this much of the holder's
        /// notes unspent.
        uint256 locked;
    }

    struct TokenRules {
        /// Has the issuer switched holder-to-holder transfers on?
        bool transfersEnabled;
        /// Is the issuer's investor cap reached? While it is, a transfer that
        /// would make a new investor is allowed only when the sender stops
        /// being one.
        bool investorCapReached;
        /// Must a transfer move the sender's entire balance?
        bool fullBalanceRequired;
        /// The least a holder must keep after a partial transfer (0: none).
        uint256 minHolding;
        /// Does `minHolding` also forbid a full exit?
        bool minHoldingStrict;
    }

    function holderRules(address account) external view returns (HolderRules memory);
    function tokenRules() external view returns (TokenRules memory);
    /// Is the token paused by its issuer?
    function paused() external view returns (bool);
}
