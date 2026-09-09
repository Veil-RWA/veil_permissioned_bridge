// Big-endian byte packing for LayerZero message payloads.
//
// Reimplemented rather than pulled from `lz_utils::byte_array_ext` because that
// package pins `starknet = "2.14.0"` / `openzeppelin = "2.0.0"` (umbrella) /
// `snforge_std = "0.49.0"`, while this repo is on 2.17.0 / the split OZ crates /
// snforge 0.58.1 — and LayerZero's own docs warn that mismatched versions
// produce class-hash mismatch errors. The encoding here is byte-for-byte the
// same as theirs (and as Solidity's `abi.encodePacked`), which is the only part
// that has to agree across the wire. See src/bridge/README.md for the swap path
// back to the upstream package.
//
// Every integer is written most-significant byte first, with no padding beyond
// the declared width, so a payload built here decodes with `read_u*` on the
// LayerZero Cairo side and with `abi.decode`-style offset reads in Solidity.

/// Append `width` bytes of `value`, most significant byte first.
///
/// Bytes above `width` are silently dropped, so callers must range-check first
/// where truncation would be a bug (see `msg_codec`, which asserts EVM
/// addresses fit in 20 bytes before packing them).
pub fn append_be(ref buf: ByteArray, value: u256, width: u32) {
    // Split into little-endian bytes, then emit reversed: ByteArray only
    // appends at the tail, and we want the most significant byte first.
    let mut le: Array<u8> = array![];
    let mut v = value;
    let mut i = width;
    while i != 0 {
        // 256 divides 2^128, so the low limb alone carries the low byte.
        let byte: u8 = (v.low % 256).try_into().unwrap();
        le.append(byte);
        v = v / 256;
        i -= 1;
    }

    let mut j = le.len();
    while j != 0 {
        j -= 1;
        buf.append_byte(*le.at(j));
    }
}

/// Read `width` big-endian bytes at `offset`. Panics if the payload is short,
/// which is what we want: a truncated message is a protocol error, not a
/// policy outcome, and must not be silently interpreted as zeroes.
pub fn read_be(buf: @ByteArray, offset: u32, width: u32) -> u256 {
    let mut acc: u256 = 0;
    let mut i: u32 = 0;
    while i != width {
        let byte = buf.at(offset + i).expect('BRIDGE_MSG_TRUNCATED');
        acc = acc * 256 + byte.into();
        i += 1;
    }
    acc
}

pub fn append_u8(ref buf: ByteArray, value: u8) {
    buf.append_byte(value);
}

pub fn append_u16(ref buf: ByteArray, value: u16) {
    append_be(ref buf, value.into(), 2);
}

pub fn append_u64(ref buf: ByteArray, value: u64) {
    append_be(ref buf, value.into(), 8);
}

pub fn append_u128(ref buf: ByteArray, value: u128) {
    append_be(ref buf, value.into(), 16);
}

pub fn append_u256(ref buf: ByteArray, value: u256) {
    append_be(ref buf, value, 32);
}

pub fn read_u8(buf: @ByteArray, offset: u32) -> u8 {
    read_be(buf, offset, 1).low.try_into().unwrap()
}

pub fn read_u16(buf: @ByteArray, offset: u32) -> u16 {
    read_be(buf, offset, 2).low.try_into().unwrap()
}

pub fn read_u64(buf: @ByteArray, offset: u32) -> u64 {
    read_be(buf, offset, 8).low.try_into().unwrap()
}

pub fn read_u256(buf: @ByteArray, offset: u32) -> u256 {
    read_be(buf, offset, 32)
}

/// A byte is a bool on the wire; anything non-zero is true, matching how
/// Solidity packs a `bool` into one byte.
pub fn read_bool(buf: @ByteArray, offset: u32) -> bool {
    read_u8(buf, offset) != 0
}

pub fn append_bool(ref buf: ByteArray, value: bool) {
    buf.append_byte(if value {
        1_u8
    } else {
        0_u8
    });
}
