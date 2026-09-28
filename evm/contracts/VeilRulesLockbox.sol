// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VeilLockboxBase} from "./VeilLockboxBase.sol";
import {IVeilRulesSource} from "./IVeilRulesSource.sol";
import {BridgeMsgCodec} from "./BridgeMsgCodec.sol";
import {MessagingFee} from "./lz/ILayerZeroEndpointV2.sol";

/// The lockbox for a rule-gated ERC-20: a token whose transfers are decided by
/// the issuer's own rules engine (eligibility, freezes, lock-ups, investor
/// caps, minimum holdings, transfer switches).
///
/// The issuer's rules are read through `IVeilRulesSource`, an adapter that
/// answers from the same data the token's own check uses. Besides the
/// eligibility snapshot every kind sends, this lockbox sends the rules
/// themselves, so the Veil pool can apply them inside its proofs:
///
///   - `syncRules(account)`: the holder's rules (may hold, frozen, counts as an
///     investor, locked amount);
///   - `syncTokenRules()`: the token's rules (transfers enabled, investor cap
///     reached, full-balance transfers, minimum holding).
///
/// Both are permissionless, like `syncCompliance`: they forward only what the
/// adapter says, so a caller cannot assert anything of their own. On Starknet
/// the records expire after the staleness window and fail closed: a holder
/// with no fresh rules cannot receive, and its notes read as fully locked.
///
/// DEPLOYMENT PRECONDITION. The token checks the recipient of every transfer,
/// and on a bridge-out this contract is the recipient: the issuer's rules must
/// admit this lockbox as a holder before any deposit can succeed.
contract VeilRulesLockbox is VeilLockboxBase {
    /// The issuer's rules, as the adapter states them.
    IVeilRulesSource public immutable rules;

    /// No locked amount or investor flag: they are the holder's position, and
    /// indexed by account they would be a free log filter over it.
    event RulesSynced(address indexed account, uint64 seq, bool canHold, bool frozen);
    event TokenRulesSynced(uint64 seq);

    constructor(address endpoint_, address owner_, address token_, uint32 dstEid_, address rules_)
        VeilLockboxBase(endpoint_, owner_, token_, dstEid_)
    {
        if (rules_ == address(0)) revert ZeroAddress();
        rules = IVeilRulesSource(rules_);
    }

    function _isEligible(address account) internal view override returns (bool) {
        return rules.holderRules(account).canHold;
    }

    function _isFrozen(address account) internal view override returns (bool) {
        return rules.holderRules(account).frozen;
    }

    function _isPaused() internal view override returns (bool) {
        return rules.paused();
    }

    /// Push `account`'s rules to the mirror.
    function syncRules(address account, uint128 gasLimit, address refundAddress)
        external
        payable
        returns (bytes32 guid)
    {
        IVeilRulesSource.HolderRules memory h = rules.holderRules(account);
        uint64 s = ++seq;
        bytes memory message = BridgeMsgCodec.encodeHolderRules(
            account, s, h.canHold, h.frozen, h.isInvestor, h.locked
        );
        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit RulesSynced(account, s, h.canHold, h.frozen);
    }

    /// Push the token's rules to the mirror.
    function syncTokenRules(uint128 gasLimit, address refundAddress)
        external
        payable
        returns (bytes32 guid)
    {
        IVeilRulesSource.TokenRules memory t = rules.tokenRules();
        uint64 s = ++globalSeq;
        bytes memory message = BridgeMsgCodec.encodeTokenRules(
            s, t.transfersEnabled, t.investorCapReached, t.fullBalanceRequired,
            t.minHoldingStrict, t.minHolding
        );
        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit TokenRulesSynced(s);
    }

    function quoteSyncRules(address account, uint128 gasLimit)
        external
        view
        returns (MessagingFee memory)
    {
        bytes memory message =
            BridgeMsgCodec.encodeHolderRules(account, seq + 1, true, false, false, 0);
        return _quote(dstEid, message, _lzReceiveOptions(gasLimit));
    }

    function quoteSyncTokenRules(uint128 gasLimit) external view returns (MessagingFee memory) {
        bytes memory message =
            BridgeMsgCodec.encodeTokenRules(globalSeq + 1, true, false, false, false, 0);
        return _quote(dstEid, message, _lzReceiveOptions(gasLimit));
    }
}
