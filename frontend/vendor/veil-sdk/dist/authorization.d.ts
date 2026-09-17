import { type Signature, type TypedData } from "starknet";
/** What signs an authorization: a starknet.js `Account`/`WalletAccount` (or
 *  anything with the same `address` + `signMessage`). */
export interface AuthorizationSigner {
    address: string;
    signMessage(typedData: TypedData): Promise<Signature>;
    getChainId?(): Promise<string>;
}
export declare const AUTHORIZATION_TYPES: {
    StarknetDomain: {
        name: string;
        type: string;
    }[];
    Authorization: {
        name: string;
        type: string;
    }[];
};
export interface AuthorizationInput {
    /** The pool address. */
    pool: string | bigint;
    /** The chain id, as a felt (e.g. `shortString.encodeShortString("SN_SEPOLIA")`)
     *  or a short string ("SN_SEPOLIA"). */
    chainId: string | bigint;
    /** The derive's name, e.g. "deposit" or "deposit_derive". */
    operation: string;
    /** The derive's arguments before (`auth_nonce`, `signature`), as hex felts. */
    deriveCalldata: string[];
    nonce: bigint;
}
/** The SNIP-12 typed data a wallet signs for one derive. */
export declare function authorizationTypedData(input: AuthorizationInput): TypedData;
/** The hash `signer` signs (the pool's `get_authorization_hash`). */
export declare function authorizationHash(input: AuthorizationInput, signer: string | bigint): bigint;
/** A fresh random nonce (< 2^248). */
export declare function randomAuthNonce(): bigint;
/** `deriveCalldata` followed by (`auth_nonce`, `signature`), signed by `signer`.
 *  `chainId` defaults to the signer's own. */
export declare function authorizeDeriveCalldata(args: {
    signer: AuthorizationSigner;
    pool: string | bigint;
    operation: string;
    deriveCalldata: string[];
    chainId?: string | bigint;
    nonce?: bigint;
}): Promise<string[]>;
