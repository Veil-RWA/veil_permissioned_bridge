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
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { typedData } from "starknet";
export function isEvmSigner(signer) {
    return signer.kind === "evm";
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
    const chainId = args.chainId ?? (isEvmSigner(signer) ? undefined : await signer.getChainId?.());
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
    const signature = isEvmSigner(signer)
        ? evmSignatureFelts(await signer.signMessage(authorizationHashBytes(authorizationHash(input, signer.address))))
        : signatureFelts(await signer.signMessage(authorizationTypedData(input)));
    return [...args.deriveCalldata, hex(nonce), hex(BigInt(signature.length)), ...signature];
}
