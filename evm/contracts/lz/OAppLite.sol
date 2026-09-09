// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "./ILayerZeroEndpointV2.sol";

/// The parts of LayerZero's `OApp` this bridge actually uses: an endpoint
/// binding, a peer table, a guarded receive, and a send that forwards the
/// caller's fee.
///
/// Behaviourally identical to `OAppCore` + `OAppSender` + `OAppReceiver` for
/// this surface -- same two assertions on receive (caller is the endpoint,
/// sender is the configured peer), same `MessagingParams` construction on send.
/// Kept local so the tree stays dependency-free for `script/build.js`.
abstract contract OAppLite is ILayerZeroReceiver {
    ILayerZeroEndpointV2 public immutable endpoint;
    address public owner;

    /// Destination eid -> the 32-byte address of our counterpart there. A
    /// Starknet peer is its contract address widened to 32 bytes; an EVM peer
    /// is its 20-byte address left-padded.
    mapping(uint32 => bytes32) public peers;

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error OnlyEndpoint();
    error OnlyPeer(uint32 eid, bytes32 sender);
    error NoPeer(uint32 eid);
    error ZeroAddress();

    constructor(address endpoint_, address owner_) {
        if (endpoint_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        endpoint = ILayerZeroEndpointV2(endpoint_);
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    function setDelegate(address delegate) external onlyOwner {
        endpoint.setDelegate(delegate);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------- receiving

    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        bytes32 peer = peers[origin.srcEid];
        if (peer == bytes32(0)) revert NoPeer(origin.srcEid);
        if (peer != origin.sender) revert OnlyPeer(origin.srcEid, origin.sender);
        _lzReceive(origin, guid, message, executor, extraData);
    }

    function _lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) internal virtual;

    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        bytes32 peer = peers[origin.srcEid];
        return peer != bytes32(0) && peer == origin.sender;
    }

    /// 0 = unordered. Compliance ordering is carried by each record's own
    /// sequence number instead, so one stuck message cannot block the channel.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    // --------------------------------------------------------------- sending

    function _peerOrRevert(uint32 eid) internal view returns (bytes32) {
        bytes32 peer = peers[eid];
        if (peer == bytes32(0)) revert NoPeer(eid);
        return peer;
    }

    function _lzSend(
        uint32 dstEid,
        bytes memory message,
        bytes memory options,
        address refundAddress
    ) internal returns (MessagingReceipt memory) {
        return endpoint.send{value: msg.value}(
            MessagingParams({
                dstEid: dstEid,
                receiver: _peerOrRevert(dstEid),
                message: message,
                options: options,
                payInLzToken: false
            }),
            refundAddress
        );
    }

    function _quote(uint32 dstEid, bytes memory message, bytes memory options)
        internal
        view
        returns (MessagingFee memory)
    {
        return endpoint.quote(
            MessagingParams({
                dstEid: dstEid,
                receiver: _peerOrRevert(dstEid),
                message: message,
                options: options,
                payInLzToken: false
            }),
            address(this)
        );
    }

    /// Type-3 executor options carrying a single `lzReceive` gas limit. 17 is
    /// the option body length: one type byte plus a 16-byte gas limit. Must
    /// stay byte-identical to `build_lz_receive_options` in src/bridge/lz.cairo.
    function _lzReceiveOptions(uint128 gasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gasLimit);
    }
}
