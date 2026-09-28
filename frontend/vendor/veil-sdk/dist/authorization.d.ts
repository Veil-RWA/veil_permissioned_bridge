import { type Signature, type TypedData } from "starknet";
/** A Starknet account that signs an authorization: a starknet.js
 *  `Account`/`WalletAccount` (or anything with the same `address` +
 *  `signMessage`). */
export interface StarknetAuthorizationSigner {
    address: string;
    signMessage(typedData: TypedData): Promise<Signature>;
    getChainId?(): Promise<string>;
}
/** An EVM wallet (EOA) acting as a holder. `signMessage` is `personal_sign`
 *  over raw bytes returning the 65-byte signature as hex — ethers'
 *  `Signer.signMessage(bytes)` exactly. Build one with `evmAuthorizationSigner`,
 *  `eip1193AuthorizationSigner` or `evmPrivateKeySigner`. The Starknet chain id
 *  cannot come from an EVM wallet, so pass `chainId` explicitly. */
export interface EvmAuthorizationSigner {
    kind: "evm";
    /** The EVM address (0x + 40 hex): the holder's address in the pool. */
    address: string;
    signMessage(message: Uint8Array): Promise<string>;
}
/** What signs an authorization. */
export type AuthorizationSigner = StarknetAuthorizationSigner | EvmAuthorizationSigner;
export declare function isEvmSigner(signer: AuthorizationSigner): signer is EvmAuthorizationSigner;
/** Wraps anything that `personal_sign`s bytes — an ethers `Signer`:
 *  `evmAuthorizationSigner(await signer.getAddress(), (m) => signer.signMessage(m))`. */
export declare function evmAuthorizationSigner(address: string, signMessage: (message: Uint8Array) => Promise<string>): EvmAuthorizationSigner;
/** A browser wallet (MetaMask, Rabby, …) through its EIP-1193 provider. */
export declare function eip1193AuthorizationSigner(provider: {
    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown>;
}, address: string): EvmAuthorizationSigner;
/** A local secp256k1 key (servers, scripts, tests). */
export declare function evmPrivateKeySigner(privateKey: string | bigint): EvmAuthorizationSigner;
/** keccak256("\x19Ethereum Signed Message:\n" + len ‖ message): what
 *  `personal_sign` signs. */
export declare function personalMessageDigest(message: Uint8Array): Uint8Array;
/** The Ethereum address of an uncompressed secp256k1 public key (65 bytes). */
export declare function evmAddressOfPublicKey(publicKey: Uint8Array): string;
/** The 32 bytes an EVM wallet signs for an authorization: the SNIP-12 hash,
 *  big-endian. */
export declare function authorizationHashBytes(hash: bigint): Uint8Array;
/** A 65-byte `personal_sign` signature as the pool takes it:
 *  [r.low, r.high, s.low, s.high, y_parity], with `s` in the lower half of the
 *  curve order (the pool refuses the high-s twin). */
export declare function evmSignatureFelts(signature: string): string[];
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
 *  `chainId` defaults to a Starknet signer's own; an EVM signer needs it. */
export declare function authorizeDeriveCalldata(args: {
    signer: AuthorizationSigner;
    pool: string | bigint;
    operation: string;
    deriveCalldata: string[];
    chainId?: string | bigint;
    nonce?: bigint;
}): Promise<string[]>;
