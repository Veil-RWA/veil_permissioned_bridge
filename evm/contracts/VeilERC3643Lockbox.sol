// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry, ICompliance, IERC3643} from "./interfaces/IERC3643.sol";
import {IERC3643Optional} from "./IERC3643Bridge.sol";
import {BridgeMsgCodec} from "./BridgeMsgCodec.sol";
import {OAppLite} from "./lz/OAppLite.sol";
import {MessagingFee, Origin} from "./lz/ILayerZeroEndpointV2.sol";

/// Escrows an EVM ERC-3643 asset and drives its permissioned Starknet twin.
///
/// The lock/mint half of the OFT-adapter pattern, with the part that pattern
/// leaves out: the compliance state travels too. A bearer token can be wrapped
/// by anyone because there is nothing to carry across; a permissioned one
/// cannot, because the twin is only as legitimate as its eligibility data. So
/// every bridge-out ships the sender's registry snapshot alongside the amount,
/// and `syncCompliance` keeps pushing updates afterwards.
///
/// DEPLOYMENT PRECONDITION. T-REX `transferFrom` verifies the *recipient*, and
/// on a bridge-out this contract is the recipient. The issuer must therefore
/// register this lockbox as a verified identity in the token's registry before
/// any deposit can succeed -- the same precondition a Veil pool has. Without it
/// `bridgeOut` reverts inside the token, not here.
///
/// AUTHORISATION. Nothing in this contract can be deployed usefully against an
/// unwilling issuer: the escrow step needs that registration, which only the
/// issuer's agent can grant. That is the intended shape. A permissioned asset
/// should not be bridgeable without the issuer's participation, and this design
/// makes their consent a live on-chain switch they can withdraw at any time by
/// de-registering the lockbox.
contract VeilERC3643Lockbox is OAppLite {
    using BridgeMsgCodec for bytes;

    IERC3643 public immutable token;

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

    event BridgedOut(
        address indexed sender,
        bytes32 indexed snRecipient,
        uint256 amount,
        uint64 seq,
        bytes32 guid,
        uint8 delivery,
        bytes32 noteId
    );
    event ComplianceSynced(
        address indexed account, uint64 seq, bool verified, bool frozen, uint16 country
    );
    event GlobalSynced(uint64 seq, bool paused);
    event Released(address indexed recipient, uint256 amount);
    event ReleaseHeld(address indexed recipient, uint256 amount, string reason);
    event Claimed(address indexed recipient, uint256 amount);
    event DstEidSet(uint32 dstEid);

    error ZeroAmount();
    error ZeroNoteId();
    error NotVerified(address account);
    error EscrowFailed();
    error NothingClaimable();
    error StillIneligible(address account);

    constructor(address endpoint_, address owner_, address token_, uint32 dstEid_)
        OAppLite(endpoint_, owner_)
    {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC3643(token_);
        dstEid = dstEid_;
    }

    // ----------------------------------------------------------------- admin

    function setDstEid(uint32 dstEid_) external onlyOwner {
        dstEid = dstEid_;
        emit DstEidSet(dstEid_);
    }

    // ------------------------------------------------------------- outbound

    /// Escrow `amount` and mint the twin to `snRecipient`'s WALLET on Starknet.
    ///
    /// `snRecipient` is a Starknet address as a 32-byte word. The sender's
    /// current registry state rides along in the same message, so a first-time
    /// bridger arrives on the far side already eligible.
    ///
    /// This lands as a public balance. To arrive inside a Veil pool instead,
    /// use `bridgeOutToPool`.
    function bridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit, address refundAddress)
        external
        payable
        returns (bytes32 guid)
    {
        return _bridge(amount, snRecipient, BridgeMsgCodec.DELIVERY_WALLET, bytes32(0), gasLimit, refundAddress);
    }

    /// Escrow `amount` and have it filled into `noteId`, an open note the
    /// recipient holds in a Veil pool on Starknet, so the position arrives
    /// confidential rather than as a public balance.
    ///
    /// Delivery is best-effort by design. If the far side has no adapter
    /// configured, or the adapter refuses, or the note cannot be filled, the
    /// amount lands in `snRecipient`'s wallet instead. It is never lost and
    /// never stranded -- the escrow here is already spent by the time the
    /// message arrives, so the far side may not reject it.
    function bridgeOutToPool(
        uint256 amount,
        bytes32 snRecipient,
        bytes32 noteId,
        uint128 gasLimit,
        address refundAddress
    ) external payable returns (bytes32 guid) {
        if (noteId == bytes32(0)) revert ZeroNoteId();
        return _bridge(amount, snRecipient, BridgeMsgCodec.DELIVERY_POOL, noteId, gasLimit, refundAddress);
    }

    function _bridge(
        uint256 amount,
        bytes32 snRecipient,
        uint8 delivery,
        bytes32 noteId,
        uint128 gasLimit,
        address refundAddress
    ) private returns (bytes32 guid) {
        if (amount == 0) revert ZeroAmount();

        IIdentityRegistry registry = IIdentityRegistry(token.identityRegistry());
        // Fail fast. The escrow below would revert anyway on a strict T-REX
        // token, but an unverified sender who slipped past it would only end up
        // quarantined on Starknet, having paid for a message that cannot mint.
        if (!registry.isVerified(msg.sender)) revert NotVerified(msg.sender);

        // The token's own gate is the authority on whether this escrow is
        // allowed -- pause, freeze, compliance modules and recipient
        // verification all run inside `transferFrom`.
        if (!token.transferFrom(msg.sender, address(this), amount)) revert EscrowFailed();
        totalEscrowed += amount;

        uint64 s = ++seq;
        bytes memory message = BridgeMsgCodec.encodeMint(
            msg.sender,
            snRecipient,
            amount,
            s,
            true,
            _isFrozen(msg.sender),
            registry.investorCountry(msg.sender),
            delivery,
            noteId
        );

        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit BridgedOut(msg.sender, snRecipient, amount, s, guid, delivery, noteId);
    }

    /// Push `account`'s current eligibility to the mirror. Permissionless by
    /// design: it forwards only what the live registry already says, so the
    /// caller cannot assert anything of their own. That is what makes the
    /// mirror's staleness window a bounded, publicly closable gap rather than a
    /// dependency on one operator staying online.
    function syncCompliance(address account, uint128 gasLimit, address refundAddress)
        external
        payable
        returns (bytes32 guid)
    {
        IIdentityRegistry registry = IIdentityRegistry(token.identityRegistry());
        bool verified = registry.isVerified(account);
        bool frozen = _isFrozen(account);
        uint16 country = registry.investorCountry(account);

        uint64 s = ++seq;
        bytes memory message = BridgeMsgCodec.encodeIdentity(account, s, verified, frozen, country);
        guid = _lzSend(dstEid, message, _lzReceiveOptions(gasLimit), refundAddress).guid;
        emit ComplianceSynced(account, s, verified, frozen, country);
    }

    /// Push token-level state. Only the pause flag: compliance RULE parameters
    /// (holding caps, supply limits, country lists) are replicated once at
    /// allowance time into the Starknet `MirroredCompliance` by
    /// `tools/export-compliance.js`, rather than streamed over the wire, so
    /// each rule has exactly one home. Permissionless -- `paused` is read from
    /// the token, so a caller contributes nothing but the gas.
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

    /// Message size does not vary with the delivery mode -- MINT is fixed
    /// width -- so one quote covers both entrypoints.
    function quoteBridgeOut(uint256 amount, bytes32 snRecipient, uint128 gasLimit)
        external
        view
        returns (MessagingFee memory)
    {
        bytes memory message = BridgeMsgCodec.encodeMint(
            msg.sender, snRecipient, amount, seq + 1, true, false, 0,
            BridgeMsgCodec.DELIVERY_WALLET, bytes32(0)
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

        IIdentityRegistry registry = IIdentityRegistry(token.identityRegistry());
        if (!registry.isVerified(recipient)) {
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

        IIdentityRegistry registry = IIdentityRegistry(token.identityRegistry());
        if (!registry.isVerified(recipient)) revert StillIneligible(recipient);

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

    // --------------------------------------------------------------- reads

    /// Optional T-REX getters, read defensively. An absent getter reads as
    /// "not frozen" / "not paused" rather than reverting the whole bridge --
    /// the authoritative gate is the token's own `transfer`, which still runs.
    function _isFrozen(address account) private view returns (bool) {
        (bool success, bytes memory ret) = address(token).staticcall(
            abi.encodeWithSelector(IERC3643Optional.isFrozen.selector, account)
        );
        return success && ret.length == 32 && abi.decode(ret, (bool));
    }

    function _isPaused() private view returns (bool) {
        (bool success, bytes memory ret) =
            address(token).staticcall(abi.encodeWithSelector(IERC3643Optional.paused.selector));
        return success && ret.length == 32 && abi.decode(ret, (bool));
    }
}
