// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Like} from "./interfaces/IERC3643.sol";
import {IERC3643Optional} from "./IERC3643Bridge.sol";
import {BridgeMsgCodec} from "./BridgeMsgCodec.sol";
import {OAppLite} from "./lz/OAppLite.sol";
import {MessagingFee, Origin} from "./lz/ILayerZeroEndpointV2.sol";

/// Escrows a permissioned EVM asset and drives its Starknet twin.
///
/// The lock/mint half of the OFT-adapter pattern, with the part that pattern
/// leaves out: the eligibility state travels too. A bearer token can be wrapped
/// by anyone because there is nothing to carry across; a permissioned one
/// cannot, because the twin is only as legitimate as its eligibility data. So
/// every bridge-out ships the sender's eligibility snapshot alongside the
/// amount, and `syncCompliance` keeps pushing updates afterwards.
///
/// WHERE ELIGIBILITY COMES FROM is the only thing that differs between kinds of
/// permissioned asset, so it is the only thing a concrete lockbox supplies:
///
///   - an ERC-3643 token answers from its identity registry
///     (`VeilERC3643Lockbox`);
///   - an allowlisted ERC-20 answers from the issuer's allowlist
///     (`VeilAllowlistLockbox`);
///   - a rule-gated ERC-20 answers from the issuer's rules, read through an
///     adapter (`VeilRulesLockbox`).
///
/// Everything else -- escrow through the token's own gate, the messages, the
/// ordering, the release and the held-release path -- is the same, and lives
/// here once.
///
/// DEPLOYMENT PRECONDITION. The token's own gate decides whether the escrow may
/// happen, and on a bridge-out this contract is the recipient. The issuer must
/// therefore admit this lockbox as a holder (register it, allowlist it, or
/// approve it in its rules) before any deposit can succeed. Without it
/// `bridgeOut` reverts inside the token, not here.
///
/// AUTHORISATION. Nothing in this contract can be deployed usefully against an
/// unwilling issuer: the escrow step needs that admission, which only the
/// issuer can grant. That is the intended shape. A permissioned asset should
/// not be bridgeable without the issuer's participation, and this design makes
/// their consent a live on-chain switch they can withdraw at any time.
abstract contract VeilLockboxBase is OAppLite {
    IERC20Like public immutable token;

    /// Endpoint id of the Starknet deployment (30500 mainnet, 40500 sepolia).
    uint32 public dstEid;

    /// Strictly increasing across every per-account message this contract
    /// sends. The mirror drops any record whose sequence is not newer than the
    /// one it holds, which is what makes LayerZero's unordered delivery safe.
    uint64 public seq;
    uint64 public globalSeq;

    /// Escrow released back to an address that was not eligible at the moment
    /// the release arrived. Held, not lost.
    mapping(address => uint256) public claimable;
    uint256 public totalClaimable;

    /// Tokens held against minted supply on Starknet. `totalEscrowed` minus
    /// `totalClaimable` is the amount still represented by live twin supply.
    uint256 public totalEscrowed;

    /// Carries no Starknet destination. `sender` is `msg.sender` and public
    /// regardless, but an indexed pair would hand anyone a cross-chain linkage
    /// query for free. The destination is in the message; `guid` identifies it.
    event BridgedOut(address indexed sender, uint256 amount, uint64 seq, bytes32 guid);
    /// No `country`. It is a KYC attribute that nothing reads back, and indexed
    /// by account it becomes "every holder from country X" as a log filter.
    event ComplianceSynced(address indexed account, uint64 seq, bool verified, bool frozen);
    event GlobalSynced(uint64 seq, bool paused);
    event Released(address indexed recipient, uint256 amount);
    event ReleaseHeld(address indexed recipient, uint256 amount, string reason);
    event Claimed(address indexed recipient, uint256 amount);
    event DstEidSet(uint32 dstEid);

    error ZeroAmount();
    error ZeroNoteId();
    error AmountTooLargeForNote();
    error NotVerified(address account);
    error EscrowFailed();
    error NothingClaimable();
    error StillIneligible(address account);

    constructor(address endpoint_, address owner_, address token_, uint32 dstEid_)
        OAppLite(endpoint_, owner_)
    {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20Like(token_);
        dstEid = dstEid_;
    }

    // ------------------------------------------------------------ eligibility

    /// May `account` hold the asset, per the issuer's own records?
    function _isEligible(address account) internal view virtual returns (bool);

    /// Has the issuer frozen `account`? Default: the token's optional
    /// `isFrozen`, read defensively.
    function _isFrozen(address account) internal view virtual returns (bool) {
        (bool success, bytes memory ret) = address(token).staticcall(
            abi.encodeWithSelector(IERC3643Optional.isFrozen.selector, account)
        );
        return success && ret.length == 32 && abi.decode(ret, (bool));
    }

    /// The holder's ISO-3166 numeric country, for kinds whose Starknet rules
    /// read it. Default: none.
    function _country(address) internal view virtual returns (uint16) {
        return 0;
    }

    /// Has the issuer paused the asset? Default: the token's optional
    /// `paused`, read defensively.
    function _isPaused() internal view virtual returns (bool) {
        (bool success, bytes memory ret) =
            address(token).staticcall(abi.encodeWithSelector(IERC3643Optional.paused.selector));
        return success && ret.length == 32 && abi.decode(ret, (bool));
    }

    // ----------------------------------------------------------------- admin

    function setDstEid(uint32 dstEid_) external onlyOwner {
        dstEid = dstEid_;
        emit DstEidSet(dstEid_);
    }

    // ------------------------------------------------------------- outbound

    /// Escrow `amount` and have it filled into `noteId`, an open note the
    /// recipient holds in a Veil pool on Starknet.
    ///
    /// This is the ONLY way across. A bridge-in always lands in a Veil pool
    /// note: the twin is a permissioned asset whose point is to settle
    /// privately inside the pool, so there is no wallet delivery and no wallet
    /// fallback. A transfer the far side cannot fill is quarantined on the
    /// gateway and stays claimable into a note -- never minted as a public
    /// balance.
    ///
    /// The recipient must have claimed that note on the gateway first (a wallet
    /// bridging to itself claims it with this very message), or the far side
    /// quarantines it rather than filling it.
    ///
    /// A note packs its amount into 128 bits, so anything at or above 2**128
    /// could never be delivered. Refused here, where it is free.
    ///
    /// `pool` names WHICH Veil pool. A Veil pool is multi-asset -- one pool
    /// carries any number of tokens -- so the asset does not imply the pool and
    /// the holder has to say. Zero means the gateway's default, the main Veil
    /// pool, which is what almost every transfer wants. A non-zero value sends
    /// to an entity's own pool instead, and the gateway checks it against the
    /// VeilERC3643Factory before touching it.
    function bridgeOut(
        uint256 amount,
        bytes32 snRecipient,
        bytes32 noteId,
        bytes32 pool,
        uint128 gasLimit,
        address refundAddress
    ) external payable returns (bytes32 guid) {
        if (noteId == bytes32(0)) revert ZeroNoteId();
        if (amount >= (1 << 128)) revert AmountTooLargeForNote();
        return _bridge(amount, snRecipient, noteId, pool, gasLimit, refundAddress);
    }

    function _bridge(
        uint256 amount,
        bytes32 snRecipient,
        bytes32 noteId,
        bytes32 pool,
        uint128 gasLimit,
        address refundAddress
    ) private returns (bytes32 guid) {
        if (amount == 0) revert ZeroAmount();

        // Fail fast. The escrow below would revert anyway on a strict token,
        // but an ineligible sender who slipped past it would only end up
        // quarantined on Starknet, having paid for a message that cannot mint.
        if (!_isEligible(msg.sender)) revert NotVerified(msg.sender);

        // The token's own gate is the authority on whether this escrow is
        // allowed -- pause, freeze, allowlist, rules and recipient checks all
        // run inside `transferFrom`.
        if (!token.transferFrom(msg.sender, address(this), amount)) revert EscrowFailed();
        totalEscrowed += amount;

        uint64 s = ++seq;
        bytes memory message = BridgeMsgCodec.encodeMint(
            msg.sender, snRecipient, amount, s, true, _isFrozen(msg.sender), _country(msg.sender),
            noteId, pool
        );

        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit BridgedOut(msg.sender, amount, s, guid);
    }

    /// Push `account`'s current eligibility to the mirror. Permissionless by
    /// design: it forwards only what the issuer's live records already say, so
    /// the caller cannot assert anything of their own. That is what makes the
    /// mirror's staleness window a bounded, publicly closable gap rather than a
    /// dependency on one operator staying online.
    function syncCompliance(address account, uint128 gasLimit, address refundAddress)
        external
        payable
        returns (bytes32 guid)
    {
        bool verified = _isEligible(account);
        bool frozen = _isFrozen(account);
        uint16 country = _country(account);

        uint64 s = ++seq;
        bytes memory message = BridgeMsgCodec.encodeIdentity(account, s, verified, frozen, country);
        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit ComplianceSynced(account, s, verified, frozen);
    }

    /// Push token-level state: the pause flag. Permissionless -- it is read
    /// from the issuer's own contracts, so a caller contributes nothing but
    /// the gas.
    function syncGlobal(uint128 gasLimit, address refundAddress)
        external
        payable
        returns (bytes32 guid)
    {
        bool paused = _isPaused();
        uint64 s = ++globalSeq;
        bytes memory message = BridgeMsgCodec.encodeGlobal(s, paused);
        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit GlobalSynced(s, paused);
    }

    function quoteBridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit)
        external
        view
        returns (MessagingFee memory)
    {
        // MINT is fixed width, so one quote covers both entrypoints.
        bytes memory message = BridgeMsgCodec.encodeMint(
            msg.sender, snRecipient, amount, seq + 1, true, false, 0,
            bytes32(0), bytes32(0)
        );
        return _quote(dstEid, message, _lzReceiveOptions(gasLimit));
    }

    function quoteSyncCompliance(address account, uint128 gasLimit)
        external
        view
        returns (MessagingFee memory)
    {
        bytes memory message = BridgeMsgCodec.encodeIdentity(account, seq + 1, true, false, 0);
        return _quote(dstEid, message, _lzReceiveOptions(gasLimit));
    }

    // -------------------------------------------------------------- inbound

    /// Release escrow on instruction from the Starknet gateway.
    ///
    /// Never reverts on a policy outcome. The twin is already burned by the
    /// time this runs, so refusing the release would destroy the holder's
    /// claim; an ineligible recipient is parked in `claimable` instead.
    function _lzReceive(Origin calldata, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        (address recipient, uint256 amount) = BridgeMsgCodec.decodeUnlock(message);

        if (!_isEligible(recipient)) {
            _hold(recipient, amount, "recipient not verified");
            return;
        }

        // `transfer` runs the token's own gate; a revert there is a policy
        // answer, not a protocol failure, so it is caught rather than bubbled.
        // The subtraction stays checked on purpose. A release larger than the
        // escrow can only mean the Starknet side minted supply this contract
        // never backed, and reverting -- leaving the message retryable and the
        // escrow untouched -- is the right response to that, not a soft
        // saturating write that would quietly absorb the discrepancy.
        try token.transfer(recipient, amount) returns (bool ok) {
            if (ok) {
                totalEscrowed -= amount;
                emit Released(recipient, amount);
            } else {
                _hold(recipient, amount, "transfer returned false");
            }
        } catch {
            _hold(recipient, amount, "transfer reverted");
        }
    }

    /// Retry a held release. Permissionless: the funds can only go to the
    /// recipient the original message named.
    function claim(address recipient) external returns (uint256 amount) {
        amount = claimable[recipient];
        if (amount == 0) revert NothingClaimable();

        if (!_isEligible(recipient)) revert StillIneligible(recipient);

        // Clear before the external call so a re-entrant claim finds nothing.
        claimable[recipient] = 0;
        totalClaimable -= amount;

        if (!token.transfer(recipient, amount)) revert EscrowFailed();
        totalEscrowed -= amount;
        emit Claimed(recipient, amount);
    }

    function _hold(address recipient, uint256 amount, string memory reason) private {
        claimable[recipient] += amount;
        totalClaimable += amount;
        emit ReleaseHeld(recipient, amount, reason);
    }
}
