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
import { typedData } from "starknet";
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
 *  `chainId` defaults to the signer's own. */
export async function authorizeDeriveCalldata(args) {
    const chainId = args.chainId ?? (await args.signer.getChainId?.());
    if (chainId === undefined) {
        throw new Error("authorizeDeriveCalldata: chainId is required (the signer does not expose it)");
    }
    const nonce = args.nonce ?? randomAuthNonce();
    const signature = signatureFelts(await args.signer.signMessage(authorizationTypedData({
        pool: args.pool,
        chainId,
        operation: args.operation,
        deriveCalldata: args.deriveCalldata,
        nonce,
    })));
    return [...args.deriveCalldata, hex(nonce), hex(BigInt(signature.length)), ...signature];
}
