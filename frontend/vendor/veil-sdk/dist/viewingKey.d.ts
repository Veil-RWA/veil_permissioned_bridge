/** The one typed message a Veil account ever signs to obtain its viewing key.
 *  `chainId` is part of the standard SNIP-12 domain; everything else is fixed. */
export declare function viewingKeyTypedData(chainId: string): {
    types: {
        StarkNetDomain: {
            name: string;
            type: string;
        }[];
        Message: {
            name: string;
            type: string;
        }[];
    };
    primaryType: string;
    domain: {
        name: string;
        chainId: string;
        version: string;
    };
    message: {
        content: string;
    };
};
/** Message hash for a given signer — lets a caller check a wallet signed the
 *  message we expect before trusting the key derived from it. */
export declare function viewingKeyMessageHash(chainId: string, account: string): bigint;
/** Normalize the shapes wallets return signatures in. */
export declare function signatureToRS(sig: unknown): {
    r: bigint;
    s: bigint;
};
/** k = poseidon(r, s), rehashed until it satisfies the contract's range rule.
 *
 *  Veil requires `0 < k < curve_order/2` (`viewing_key_as_scalar`), while
 *  Poseidon returns a felt252 that can exceed that bound — about half the time.
 *  Rehashing rather than reducing modulo the bound keeps the result uniform;
 *  `k mod bound` would make small keys twice as likely. */
export declare function viewingKeyFromSignature(sig: unknown): bigint;
export interface DerivedViewingKey {
    /** Private viewing key. Never persist it — re-derive from the wallet. */
    privateKey: bigint;
    /** (k·G).x — the value `register_viewing_key` publishes. */
    publicKey: bigint;
}
/** Sign the typed message and derive the account's viewing key pair. */
export declare function deriveViewingKey(account: {
    signMessage: (data: never) => Promise<unknown>;
}, chainId: string): Promise<DerivedViewingKey>;
/** Verify a signature against a RAW Stark public key — must be the FULL curve
 *  point (`ec.starkCurve.getPublicKey`); the x-only stark key an account stores
 *  always fails. For Argent/Braavos/multisig, ask the account instead: their
 *  contract defines what a valid signature is (see the on-chain variant). */
export declare function verifyViewingKeySignature(sig: unknown, chainId: string, account: string, publicKey: string | Uint8Array): boolean;
/** The authoritative check on Starknet: SNIP-6 `is_valid_signature` on the
 *  account contract, which works for every wallet shape including multisig. */
export declare function verifyViewingKeySignatureOnChain(provider: {
    callContract: (call: {
        contractAddress: string;
        entrypoint: string;
        calldata: string[];
    }) => Promise<string[] | {
        result?: string[];
    }>;
}, sig: unknown, chainId: string, account: string): Promise<boolean>;
