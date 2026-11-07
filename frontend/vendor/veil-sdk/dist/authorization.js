// Derive authorization for the ERC-3643 pool.
//
// Every `*_derive` ends with (`auth_nonce`, `signature`): the acting account's
// signature over a SNIP-12 (revision 1) `Authorization` naming the pool, the
// derive, its other arguments and the nonce. The derive checks it inside the
// proof with the account's own `is_valid_signature` (as StarkWare's pool does),
// so the prover's relayer can send both transactions without the account ever
// appearing on-chain. The pool computes the same hash in
// `get_authorization_hash`; `the_authorization_is_the_snip12_message_wallets_sign`
// (tests/test_strk20_primitives.cairo) pins the two together.
//
// The acting account is the note owner (the maker for DvP), the agent for a
// forced transfer, and the exchange for a batch.
//
// An EVM wallet can be the holder too: its 20-byte address is the holder's
// address in the pool (no Starknet account behind it), and it signs the same
// hash with `personal_sign` (EIP-191 over the 32 bytes). The pool recovers the
// secp256k1 key inside the proof (src/helpers/evm_signature.cairo). EOAs only:
// a smart-contract wallet's signature does not recover to its address.
//
// A Stellar wallet (Freighter, Stellar Wallets Kit, a local Keypair) can be the
// holder as well: its Ed25519 key derives the holder address
// (`stellarHolderAddress`, = src/helpers/stellar_signature.cairo
// `stellar_holder`), and it signs the text "Veil authorization\n0x<64 hex>"
// with SEP-53 `signMessage`. The pool verifies Ed25519 inside the proof.
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { hash as starkHash, typedData } from "starknet";
export function isEvmSigner(signer) {
    return signer.kind === "evm";
}
export function isStellarSigner(signer) {
    return signer.kind === "stellar";
}
// ── Stellar ──────────────────────────────────────────────────────────────────
const TWO_POW_249 = 1n << 249n;
const STELLAR_HOLDER_TAG = "0x" + bytesToHex(new TextEncoder().encode("VEIL_STELLAR_HOLDER"));
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STRKEY_ACCOUNT_VERSION = 6 << 3; // 'G'
function crc16xmodem(data) {
    let crc = 0;
    for (const b of data) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}
/** The 32-byte Ed25519 key of a `G…` account StrKey (version byte and CRC16
 *  checked). */
export function stellarPublicKeyBytes(publicKey) {
    if (!/^G[A-Z2-7]{55}$/.test(publicKey))
        throw new Error(`not a Stellar account key: ${publicKey}`);
    let bits = 0;
    let value = 0;
    const out = [];
    for (const c of publicKey) {
        value = (value << 5) | BASE32.indexOf(c);
        bits += 5;
        if (bits >= 8) {
            out.push((value >> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    const raw = Uint8Array.from(out); // 35 bytes: version ‖ key ‖ crc16 (LE)
    if (raw.length !== 35 || raw[0] !== STRKEY_ACCOUNT_VERSION)
        throw new Error(`not a Stellar account key: ${publicKey}`);
    const crc = crc16xmodem(raw.slice(0, 33));
    if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8)
        throw new Error(`bad StrKey checksum: ${publicKey}`);
    return raw.slice(1, 33);
}
/** The `G…` StrKey of a 32-byte Ed25519 key. */
export function stellarStrKey(key) {
    if (key.length !== 32)
        throw new Error("Ed25519 key must be 32 bytes");
    const raw = new Uint8Array(35);
    raw[0] = STRKEY_ACCOUNT_VERSION;
    raw.set(key, 1);
    const crc = crc16xmodem(raw.slice(0, 33));
    raw[33] = crc & 0xff;
    raw[34] = crc >> 8;
    let bits = 0;
    let value = 0;
    let out = "";
    for (const b of raw) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += BASE32[(value << (5 - bits)) & 31];
    return out;
}
/** The pool address of a Stellar holder:
 *  2^249 + (poseidon('VEIL_STELLAR_HOLDER', pk.high, pk.low) mod 2^249). */
export function stellarHolderAddress(publicKey) {
    const key = typeof publicKey === "string" ? stellarPublicKeyBytes(publicKey) : publicKey;
    if (key.length !== 32)
        throw new Error("Ed25519 key must be 32 bytes");
    const pk = BigInt("0x" + bytesToHex(key));
    const h = BigInt(starkHash.computePoseidonHashOnElements([STELLAR_HOLDER_TAG, hex(pk >> 128n), hex(pk & U128_MASK)]));
    return hex(TWO_POW_249 + (h % TWO_POW_249));
}
/** The text a Stellar wallet signs for an authorization hash. */
export function stellarAuthorizationMessage(hash) {
    return "Veil authorization\n0x" + hash.toString(16).padStart(64, "0");
}
/** SEP-53: SHA256("Stellar Signed Message:\n" ‖ message), the bytes Ed25519 signs. */
export function sep53Digest(message) {
    const prefix = new TextEncoder().encode("Stellar Signed Message:\n");
    const body = new TextEncoder().encode(message);
    const data = new Uint8Array(prefix.length + body.length);
    data.set(prefix);
    data.set(body, prefix.length);
    return sha256(data);
}
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64ToBytes(s) {
    const out = [];
    let bits = 0;
    let value = 0;
    for (const c of s.replace(/=+$/, "")) {
        value = ((value << 6) | BASE64.indexOf(c)) & 0xffffff;
        bits += 6;
        if (bits >= 8) {
            out.push((value >> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}
/** Normalizes a wallet's signature to its 64 bytes: raw bytes, hex, base64,
 *  or base64 of base64 (some wallet versions double-encode). */
export function stellarSignatureBytes(signature) {
    if (typeof signature !== "string") {
        if (signature.length !== 64)
            throw new Error("Stellar signature must be 64 bytes");
        return signature;
    }
    const t = signature.trim();
    const h = t.replace(/^0x/, "");
    if (/^[0-9a-fA-F]{128}$/.test(h))
        return hexToBytes(h);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t))
        throw new Error("unrecognized Stellar signature encoding");
    const once = base64ToBytes(t);
    if (once.length === 64)
        return once;
    const inner = new TextDecoder().decode(once);
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(inner)) {
        const twice = base64ToBytes(inner);
        if (twice.length === 64)
            return twice;
    }
    throw new Error("Stellar signature must be 64 bytes");
}
function u256Felts(b) {
    const v = BigInt("0x" + bytesToHex(b));
    return [v & U128_MASK, v >> 128n];
}
/** The pool's signature felts for a Stellar wallet:
 *  [pk.low, pk.high, R.low, R.high, S.low, S.high], each 32 bytes big-endian. */
export function stellarSignatureFelts(publicKey, signature) {
    const key = typeof publicKey === "string" ? stellarPublicKeyBytes(publicKey) : publicKey;
    const sig = stellarSignatureBytes(signature);
    return [...u256Felts(key), ...u256Felts(sig.slice(0, 32)), ...u256Felts(sig.slice(32))].map(hex);
}
/** Checks a SEP-53 signature off-chain, as the pool does (strict Ed25519). */
export function verifyStellarAuthorization(publicKey, hash, signature) {
    try {
        return ed25519.verify(stellarSignatureBytes(signature), sep53Digest(stellarAuthorizationMessage(hash)), stellarPublicKeyBytes(publicKey), { zip215: false });
    }
    catch {
        return false;
    }
}
/** Wraps any SEP-53 `signMessage`. */
export function stellarAuthorizationSigner(publicKey, signMessage) {
    return { kind: "stellar", publicKey, address: stellarHolderAddress(publicKey), signMessage };
}
/** Freighter (`@stellar/freighter-api`): pass its `signMessage`. Freighter
 *  returns `{ signedMessage, signerAddress, error }`. */
export function freighterAuthorizationSigner(freighterSignMessage, publicKey) {
    return stellarAuthorizationSigner(publicKey, async (message) => {
        const r = await freighterSignMessage(message, { address: publicKey });
        if (r.error)
            throw new Error(`Freighter signMessage failed: ${JSON.stringify(r.error)}`);
        if (r.signerAddress && r.signerAddress !== publicKey)
            throw new Error("Freighter signed with another account");
        if (!r.signedMessage)
            throw new Error("Freighter returned no signature");
        return r.signedMessage;
    });
}
/** Stellar Wallets Kit: pass the kit (its `signMessage(message, { address })`
 *  returns `{ signedMessage, signerAddress }`). */
export function stellarWalletsKitSigner(kit, publicKey) {
    return stellarAuthorizationSigner(publicKey, async (message) => {
        const r = await kit.signMessage(message, { address: publicKey });
        if (r.signerAddress && r.signerAddress !== publicKey)
            throw new Error("the wallet signed with another account");
        return r.signedMessage;
    });
}
/** A local Ed25519 seed (servers, scripts, tests): SEP-53 exactly as
 *  js-stellar-sdk's `Keypair.signMessage`. */
export function stellarKeypairSigner(seed) {
    if (seed.length !== 32)
        throw new Error("Ed25519 seed must be 32 bytes");
    const publicKey = stellarStrKey(ed25519.getPublicKey(seed));
    return stellarAuthorizationSigner(publicKey, async (message) => ed25519.sign(sep53Digest(message), seed));
}
const TWO_POW_160 = 1n << 160n;
const SECP256K1_N = secp256k1.CURVE.n;
const U128_MASK = (1n << 128n) - 1n;
function evmAddress(address) {
    const a = BigInt(address);
    if (a === 0n || a >= TWO_POW_160)
        throw new Error(`not an EVM address: ${address}`);
    return "0x" + a.toString(16).padStart(40, "0");
}
/** Wraps anything that `personal_sign`s bytes — an ethers `Signer`:
 *  `evmAuthorizationSigner(await signer.getAddress(), (m) => signer.signMessage(m))`. */
export function evmAuthorizationSigner(address, signMessage) {
    return { kind: "evm", address: evmAddress(address), signMessage };
}
/** A browser wallet (MetaMask, Rabby, …) through its EIP-1193 provider. */
export function eip1193AuthorizationSigner(provider, address) {
    const from = evmAddress(address);
    return evmAuthorizationSigner(from, async (message) => {
        const sig = await provider.request({
            method: "personal_sign",
            params: ["0x" + bytesToHex(message), from],
        });
        return String(sig);
    });
}
/** A local secp256k1 key (servers, scripts, tests). */
export function evmPrivateKeySigner(privateKey) {
    const key = typeof privateKey === "bigint" ? privateKey : BigInt(privateKey);
    const keyHex = key.toString(16).padStart(64, "0");
    const address = evmAddressOfPublicKey(secp256k1.getPublicKey(keyHex, false));
    return evmAuthorizationSigner(address, async (message) => {
        const sig = secp256k1.sign(personalMessageDigest(message), keyHex);
        return ("0x" +
            sig.r.toString(16).padStart(64, "0") +
            sig.s.toString(16).padStart(64, "0") +
            (27 + sig.recovery).toString(16));
    });
}
/** keccak256("\x19Ethereum Signed Message:\n" + len ‖ message): what
 *  `personal_sign` signs. */
export function personalMessageDigest(message) {
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
    const data = new Uint8Array(prefix.length + message.length);
    data.set(prefix);
    data.set(message, prefix.length);
    return keccak_256(data);
}
/** The Ethereum address of an uncompressed secp256k1 public key (65 bytes). */
export function evmAddressOfPublicKey(publicKey) {
    return "0x" + bytesToHex(keccak_256(publicKey.slice(1))).slice(-40);
}
/** The 32 bytes an EVM wallet signs for an authorization: the SNIP-12 hash,
 *  big-endian. */
export function authorizationHashBytes(hash) {
    return hexToBytes(hash.toString(16).padStart(64, "0"));
}
/** A 65-byte `personal_sign` signature as the pool takes it:
 *  [r.low, r.high, s.low, s.high, y_parity], with `s` in the lower half of the
 *  curve order (the pool refuses the high-s twin). */
export function evmSignatureFelts(signature) {
    const h = signature.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{130}$/.test(h))
        throw new Error("EVM signature must be 65 bytes (r ‖ s ‖ v)");
    const bytes = hexToBytes(h);
    const r = BigInt("0x" + bytesToHex(bytes.slice(0, 32)));
    let s = BigInt("0x" + bytesToHex(bytes.slice(32, 64)));
    const v = bytes[64];
    let parity;
    if (v === 0 || v === 1)
        parity = v;
    else if (v === 27 || v === 28)
        parity = v - 27;
    else
        throw new Error(`unexpected EVM signature v = ${v}`);
    if (s > SECP256K1_N / 2n) {
        s = SECP256K1_N - s;
        parity ^= 1;
    }
    return [r & U128_MASK, r >> 128n, s & U128_MASK, s >> 128n, BigInt(parity)].map(hex);
}
function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(h) {
    const clean = h.length % 2 ? "0" + h : h;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
    return out;
}
const hex = (v) => "0x" + v.toString(16);
const toBig = (v) => (typeof v === "bigint" ? v : BigInt(v));
export const AUTHORIZATION_TYPES = {
    StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
    ],
    Authorization: [
        { name: "Pool", type: "ContractAddress" },
        { name: "Action", type: "selector" },
        { name: "Arguments", type: "felt*" },
        { name: "Nonce", type: "felt" },
    ],
};
function actionName(operation) {
    return operation.endsWith("_derive") ? operation : `${operation}_derive`;
}
function chainIdValue(chainId) {
    return typeof chainId === "bigint" ? hex(chainId) : chainId;
}
/** The SNIP-12 typed data a wallet signs for one derive. */
export function authorizationTypedData(input) {
    return {
        domain: { name: "Veil", version: "1", chainId: chainIdValue(input.chainId), revision: "1" },
        primaryType: "Authorization",
        types: AUTHORIZATION_TYPES,
        message: {
            Pool: hex(toBig(input.pool)),
            Action: actionName(input.operation),
            Arguments: input.deriveCalldata,
            Nonce: hex(input.nonce),
        },
    };
}
/** The hash `signer` signs (the pool's `get_authorization_hash`). */
export function authorizationHash(input, signer) {
    return BigInt(typedData.getMessageHash(authorizationTypedData(input), hex(toBig(signer))));
}
/** A fresh random nonce (< 2^248). */
export function randomAuthNonce() {
    const b = new Uint8Array(31);
    globalThis.crypto.getRandomValues(b);
    let v = 0n;
    for (const x of b)
        v = (v << 8n) | BigInt(x);
    return v;
}
function signatureFelts(sig) {
    if (Array.isArray(sig))
        return sig.map((s) => hex(BigInt(s)));
    const { r, s } = sig;
    return [hex(r), hex(s)];
}
/** `deriveCalldata` followed by (`auth_nonce`, `signature`), signed by `signer`.
 *  `chainId` defaults to a Starknet signer's own; an EVM signer needs it. */
export async function authorizeDeriveCalldata(args) {
    const signer = args.signer;
    const chainId = args.chainId ??
        (isEvmSigner(signer) || isStellarSigner(signer) ? undefined : await signer.getChainId?.());
    if (chainId === undefined) {
        throw new Error("authorizeDeriveCalldata: chainId is required (the signer does not expose it)");
    }
    const nonce = args.nonce ?? randomAuthNonce();
    const input = {
        pool: args.pool,
        chainId,
        operation: args.operation,
        deriveCalldata: args.deriveCalldata,
        nonce,
    };
    let signature;
    if (isEvmSigner(signer)) {
        signature = evmSignatureFelts(await signer.signMessage(authorizationHashBytes(authorizationHash(input, signer.address))));
    }
    else if (isStellarSigner(signer)) {
        const message = stellarAuthorizationMessage(authorizationHash(input, signer.address));
        signature = stellarSignatureFelts(signer.publicKey, await signer.signMessage(message));
    }
    else {
        signature = signatureFelts(await signer.signMessage(authorizationTypedData(input)));
    }
    return [...args.deriveCalldata, hex(nonce), hex(BigInt(signature.length)), ...signature];
}
