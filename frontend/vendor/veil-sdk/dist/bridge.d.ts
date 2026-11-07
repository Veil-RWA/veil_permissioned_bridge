import { type InvokePlan, type SameTokenInvokeBase } from "./hyperveil.js";
export type BridgeAccountFormat = "evm" | "stellar";
/** Raw 32-byte key of a G-address, interpreted big-endian as the gateway's u256. */
export declare function stellarExitRecipient(publicKey: string): bigint;
/** privacy_invoke tail: amount, recipient.low, recipient.high, max_fee.low,
 * max_fee.high, gas_limit. No felt narrowing, truncation or recipient lookup. */
export declare function bridgeExitTail(a: {
    amount: bigint;
    recipient: bigint;
    accountFormat: BridgeAccountFormat;
    maxFee: bigint;
    gasLimit: bigint;
}): string[];
/** Both recipient limbs are in invokeCalldataHash, persisted in the proven
 * InvokeSwap.calldata_hash and checked again by invoke_settle. SNIP-12 binds
 * that hash plus the adapter target, chain, pool, action, signer and nonce;
 * exits cannot be replayed in a different adapter/chain domain. The gateway's
 * account format chooses EVM vs Stellar, not the bit-length of the recipient. */
export declare function planBridgeExit(a: SameTokenInvokeBase & {
    token: bigint;
    gateway: bigint;
    amount: bigint;
    recipient: bigint;
    accountFormat: BridgeAccountFormat;
    maxFee: bigint;
    gasLimit: bigint;
}): InvokePlan;
