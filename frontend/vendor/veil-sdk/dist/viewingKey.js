// Deriving the viewing key from a typed-message signature.
//
// A Veil viewing key must not be a stored secret. It decrypts every note the
// account owns, so a lost keyfile means lost funds and a copied keyfile means a
// readable history. Instead the account signs one fixed SNIP-12 typed message
// and the key is derived from that signature: reproducible from the wallet
// alone, on any device, with nothing at rest.
//
// One account has exactly one viewing key. The pool enforces this — a second
// `register_viewing_key` for the same user reverts with VIEW_KEY_EXISTS — so
// there is nothing to enumerate and no index or per-pool scoping. The key is
// global to the account: the same key across every pool it uses.
//
// The approach follows the Typhoon SDK's signature-derived keys
// (https://github.com/typhoonmixer/typhoon_sdk), minus its head/next chaining,
// which exists there only because a user may create arbitrarily many stealth
// accounts and needs a deterministic sequence. Veil needs a single key, so the
// derivation is a single hash.
//
// Determinism note: this requires wallet signatures over typed data to be
// deterministic. Starknet accounts sign RFC-6979 style over a fixed message
// hash, so re-signing the same typed data reproduces (r, s). The message below
// is therefore fixed and MUST NOT carry a nonce, timestamp, or salt.
import { ec, shortString, typedData as td } from "starknet";
import { HALF_CURVE_ORDER, derivePublicViewingKey, poseidon, viewingKeyAsScalar } from "./crypto.js";
/** Guard against a pathological hash; each round rejects with p < 1/2. */
const MAX_REHASH_ROUNDS = 100_000;
/** The one typed message a Veil account ever signs to obtain its viewing key.
 *  `chainId` is part of the standard SNIP-12 domain; everything else is fixed. */
export function viewingKeyTypedData(chainId) {
    return {
        types: {
            StarkNetDomain: [
                { name: "name", type: "felt" },
                { name: "chainId", type: "felt" },
                { name: "version", type: "felt" },
            ],
            Message: [{ name: "content", type: "felt" }],
        },
        primaryType: "Message",
        domain: { name: "Veil", chainId, version: "1" },
        message: { content: shortString.encodeShortString("Veil Viewing Key") },
    };
}
/** Message hash for a given signer — lets a caller check a wallet signed the
 *  message we expect before trusting the key derived from it. */
export function viewingKeyMessageHash(chainId, account) {
    return BigInt(td.getMessageHash(viewingKeyTypedData(chainId), account));
}
/** Normalize the shapes wallets return signatures in. */
export function signatureToRS(sig) {
    const a = sig;
    if (a && a.r !== undefined && a.s !== undefined) {
        return { r: BigInt(a.r), s: BigInt(a.s) };
    }
    if (Array.isArray(sig)) {
        const w = sig.map((v) => BigInt(v));
        if (w.length === 2)
            return { r: w[0], s: w[1] };
        if (w.length > 2)
            return { r: w[w.length - 2], s: w[w.length - 1] };
    }
    throw new Error("unrecognized signature shape: expected {r,s} or [r,s]");
}
/** k = poseidon(r, s), rehashed until it satisfies the contract's range rule.
 *
 *  Veil requires `0 < k < curve_order/2` (`viewing_key_as_scalar`), while
 *  Poseidon returns a felt252 that can exceed that bound — about half the time.
 *  Rehashing rather than reducing modulo the bound keeps the result uniform;
 *  `k mod bound` would make small keys twice as likely. */
export function viewingKeyFromSignature(sig) {
    const { r, s } = signatureToRS(sig);
    if (r === 0n || s === 0n)
        throw new Error("refusing to derive from a zero signature component");
    let k = poseidon([r, s]);
    for (let i = 0; i < MAX_REHASH_ROUNDS; i++) {
        if (k > 0n && k < HALF_CURVE_ORDER)
            return viewingKeyAsScalar(k);
        k = poseidon([k]);
    }
    throw new Error("viewing key derivation failed to land in range");
}
/** Sign the typed message and derive the account's viewing key pair. */
export async function deriveViewingKey(account, chainId) {
    const sig = await account.signMessage(viewingKeyTypedData(chainId));
    const privateKey = viewingKeyFromSignature(sig);
    return { privateKey, publicKey: derivePublicViewingKey(privateKey) };
}
/** Verify a signature against a RAW Stark public key — must be the FULL curve
 *  point (`ec.starkCurve.getPublicKey`); the x-only stark key an account stores
 *  always fails. For Argent/Braavos/multisig, ask the account instead: their
 *  contract defines what a valid signature is (see the on-chain variant). */
export function verifyViewingKeySignature(sig, chainId, account, publicKey) {
    const { r, s } = signatureToRS(sig);
    const msgHash = viewingKeyMessageHash(chainId, account);
    try {
        // verify() needs a Signature instance; a plain {r,s} throws.
        return ec.starkCurve.verify(new ec.starkCurve.Signature(r, s), msgHash.toString(16), publicKey);
    }
    catch {
        return false;
    }
}
/** The authoritative check on Starknet: SNIP-6 `is_valid_signature` on the
 *  account contract, which works for every wallet shape including multisig. */
export async function verifyViewingKeySignatureOnChain(provider, sig, chainId, account) {
    const { r, s } = signatureToRS(sig);
    const msgHash = viewingKeyMessageHash(chainId, account);
    try {
        const raw = await provider.callContract({
            contractAddress: account,
            entrypoint: "is_valid_signature",
            calldata: [`0x${msgHash.toString(16)}`, "0x2", `0x${r.toString(16)}`, `0x${s.toString(16)}`],
        });
        const out = Array.isArray(raw) ? raw : (raw?.result ?? []);
        if (!out.length)
            return false;
        const v = BigInt(out[0]);
        return v === 1n || v === BigInt(shortString.encodeShortString("VALID"));
    }
    catch {
        return false;
    }
}
