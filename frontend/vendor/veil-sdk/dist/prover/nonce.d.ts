/** Fetch the on-chain nonce for an account. Returns the hex-encoded nonce
 *  (`"0x..."`). Address and RPC fall back to VEIL_MASTER_ACCOUNT_ADDRESS and
 *  VEIL_STARKNET_RPC_URL; both throw a clear error if unset. */
export declare function getNonce(address?: string, rpcUrl?: string): Promise<string>;
