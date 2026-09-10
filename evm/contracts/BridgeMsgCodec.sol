// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Wire format shared with src/bridge/msg_codec.cairo.
///
/// Both sides pack big-endian with no padding. The layouts are documented once,
/// in the Cairo file; this is the mirror image. `evm/test/bridge.test.js` and
/// `tests/test_bridge.cairo` pin the same fixed vectors, so a change on one
/// side that is not made on the other fails a test rather than silently
/// misreading an amount.
library BridgeMsgCodec {
    uint8 internal constant KIND_MINT = 1;
    uint8 internal constant KIND_IDENTITY = 2;
    uint8 internal constant KIND_GLOBAL = 3;
    uint8 internal constant KIND_UNLOCK = 4;

    uint256 internal constant MINT_LEN = 173;
    uint256 internal constant IDENTITY_LEN = 45;
    uint256 internal constant GLOBAL_LEN = 10;
    uint256 internal constant UNLOCK_LEN = 65;

    error BadKind(uint8 kind);
    error BadLength(uint256 length);
    error DirtyAddressWord(bytes32 word);

    function kind(bytes calldata message) internal pure returns (uint8) {
        if (message.length == 0) revert BadLength(0);
        return uint8(message[0]);
    }

    // ------------------------------------------------------------- encoding

    function encodeMint(
        address evmSender,
        bytes32 snRecipient,
        uint256 amount,
        uint64 seq,
        bool verified,
        bool frozen,
        uint16 country,
        bytes32 noteId,
        bytes32 pool
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            KIND_MINT,
            bytes32(uint256(uint160(evmSender))),
            snRecipient,
            amount,
            seq,
            verified,
            frozen,
            country,
            noteId,
            pool
        );
    }

    function encodeIdentity(
        address evmAccount,
        uint64 seq,
        bool verified,
        bool frozen,
        uint16 country
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            KIND_IDENTITY,
            bytes32(uint256(uint160(evmAccount))),
            seq,
            verified,
            frozen,
            country
        );
    }

    /// Token STATE only. Compliance RULE parameters are not synced over the
    /// wire -- they are replicated once at allowance time into the Starknet
    /// `MirroredCompliance`, which is their single home. See ../README.md.
    function encodeGlobal(uint64 seq, bool paused) internal pure returns (bytes memory) {
        return abi.encodePacked(KIND_GLOBAL, seq, paused);
    }

    // ------------------------------------------------------------- decoding

    /// The only inbound kind: Starknet asking the lockbox to release escrow.
    function decodeUnlock(bytes calldata message)
        internal
        pure
        returns (address recipient, uint256 amount)
    {
        if (message.length != UNLOCK_LEN) revert BadLength(message.length);
        if (uint8(message[0]) != KIND_UNLOCK) revert BadKind(uint8(message[0]));

        bytes32 word = bytes32(message[1:33]);
        // Reject a dirty high word rather than truncating it: a malformed peer
        // message must not be able to alias a different account.
        if (uint256(word) >> 160 != 0) revert DirtyAddressWord(word);
        recipient = address(uint160(uint256(word)));
        amount = uint256(bytes32(message[33:65]));
    }

    // Decoders for the outbound kinds, used only by tests to assert that what
    // this library encodes is what the Cairo side reads.

    function decodeMint(bytes calldata message)
        internal
        pure
        returns (
            address evmSender,
            bytes32 snRecipient,
            uint256 amount,
            uint64 seq,
            bool verified,
            bool frozen,
            uint16 country,
            bytes32 noteId,
            bytes32 pool
        )
    {
        if (message.length != MINT_LEN) revert BadLength(message.length);
        if (uint8(message[0]) != KIND_MINT) revert BadKind(uint8(message[0]));
        evmSender = address(uint160(uint256(bytes32(message[1:33]))));
        snRecipient = bytes32(message[33:65]);
        amount = uint256(bytes32(message[65:97]));
        seq = uint64(bytes8(message[97:105]));
        verified = uint8(message[105]) != 0;
        frozen = uint8(message[106]) != 0;
        country = uint16(bytes2(message[107:109]));
        noteId = bytes32(message[109:141]);
        pool = bytes32(message[141:173]);
    }

    function decodeIdentity(bytes calldata message)
        internal
        pure
        returns (address evmAccount, uint64 seq, bool verified, bool frozen, uint16 country)
    {
        if (message.length != IDENTITY_LEN) revert BadLength(message.length);
        if (uint8(message[0]) != KIND_IDENTITY) revert BadKind(uint8(message[0]));
        evmAccount = address(uint160(uint256(bytes32(message[1:33]))));
        seq = uint64(bytes8(message[33:41]));
        verified = uint8(message[41]) != 0;
        frozen = uint8(message[42]) != 0;
        country = uint16(bytes2(message[43:45]));
    }

    function decodeGlobal(bytes calldata message)
        internal
        pure
        returns (uint64 seq, bool paused)
    {
        if (message.length != GLOBAL_LEN) revert BadLength(message.length);
        if (uint8(message[0]) != KIND_GLOBAL) revert BadKind(uint8(message[0]));
        seq = uint64(bytes8(message[1:9]));
        paused = uint8(message[9]) != 0;
    }
}
