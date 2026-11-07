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
/** A Stellar wallet acting as a holder. `signMessage` is SEP-53 over a UTF-8
 *  string and returns the 64-byte Ed25519 signature (base64, hex or bytes, as
 *  wallets differ). Build one with `freighterAuthorizationSigner`,
 *  `stellarWalletsKitSigner` or `stellarKeypairSigner`. Pass `chainId`
 *  explicitly. */
export interface StellarAuthorizationSigner {
    kind: "stellar";
    /** The account's `G…` StrKey. */
    publicKey: string;
    /** The holder address in the pool (`stellarHolderAddress(publicKey)`). */
    address: string;
    signMessage(message: string): Promise<string | Uint8Array>;
}
/** What signs an authorization. */
export type AuthorizationSigner = StarknetAuthorizationSigner | EvmAuthorizationSigner | StellarAuthorizationSigner;
export declare function isEvmSigner(signer: AuthorizationSigner): signer is EvmAuthorizationSigner;
export declare function isStellarSigner(signer: AuthorizationSigner): signer is StellarAuthorizationSigner;
/** The 32-byte Ed25519 key of a `G…` account StrKey (version byte and CRC16
 *  checked). */
export declare function stellarPublicKeyBytes(publicKey: string): Uint8Array;
/** The `G…` StrKey of a 32-byte Ed25519 key. */
export declare function stellarStrKey(key: Uint8Array): string;
/** The pool address of a Stellar holder:
 *  2^249 + (poseidon('VEIL_STELLAR_HOLDER', pk.high, pk.low) mod 2^249). */
export declare function stellarHolderAddress(publicKey: string | Uint8Array): string;
/** The text a Stellar wallet signs for an authorization hash. */
export declare function stellarAuthorizationMessage(hash: bigint): string;
/** SEP-53: SHA256("Stellar Signed Message:\n" ‖ message), the bytes Ed25519 signs. */
export declare function sep53Digest(message: string): Uint8Array;
/** Normalizes a wallet's signature to its 64 bytes: raw bytes, hex, base64,
 *  or base64 of base64 (some wallet versions double-encode). */
export declare function stellarSignatureBytes(signature: string | Uint8Array): Uint8Array;
/** The pool's signature felts for a Stellar wallet:
 *  [pk.low, pk.high, R.low, R.high, S.low, S.high], each 32 bytes big-endian. */
export declare function stellarSignatureFelts(publicKey: string | Uint8Array, signature: string | Uint8Array): string[];
/** Checks a SEP-53 signature off-chain, as the pool does (strict Ed25519). */
export declare function verifyStellarAuthorization(publicKey: string, hash: bigint, signature: string | Uint8Array): boolean;
/** Wraps any SEP-53 `signMessage`. */
export declare function stellarAuthorizationSigner(publicKey: string, signMessage: (message: string) => Promise<string | Uint8Array>): StellarAuthorizationSigner;
/** Freighter (`@stellar/freighter-api`): pass its `signMessage`. Freighter
 *  returns `{ signedMessage, signerAddress, error }`. */
export declare function freighterAuthorizationSigner(freighterSignMessage: (message: string, opts: {
    address: string;
}) => Promise<{
    signedMessage?: string | Uint8Array | null;
    signerAddress?: string;
    error?: unknown;
}>, publicKey: string): StellarAuthorizationSigner;
/** Stellar Wallets Kit: pass the kit (its `signMessage(message, { address })`
 *  returns `{ signedMessage, signerAddress }`). */
export declare function stellarWalletsKitSigner(kit: {
    signMessage(message: string, opts?: {
        address?: string;
        networkPassphrase?: string;
    }): Promise<{
        signedMessage: string;
        signerAddress?: string;
    }>;
}, publicKey: string): StellarAuthorizationSigner;
/** A local Ed25519 seed (servers, scripts, tests): SEP-53 exactly as
 *  js-stellar-sdk's `Keypair.signMessage`. */
export declare function stellarKeypairSigner(seed: Uint8Array): StellarAuthorizationSigner;
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
