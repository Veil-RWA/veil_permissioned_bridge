// Permissioned bridge exits, shared by EVM and Stellar holders.
import { planSameTokenInvoke } from "./hyperveil.js";
import { assertU128, hex, u256Felts } from "./invoke.js";
import { stellarPublicKeyBytes } from "./authorization.js";
/** Raw 32-byte key of a G-address, interpreted big-endian as the gateway's u256. */
export function stellarExitRecipient(publicKey) {
    return BigInt("0x" + Array.from(stellarPublicKeyBytes(publicKey), b => b.toString(16).padStart(2, "0")).join(""));
}
/** privacy_invoke tail: amount, recipient.low, recipient.high, max_fee.low,
 * max_fee.high, gas_limit. No felt narrowing, truncation or recipient lookup. */
export function bridgeExitTail(a) {
    assertU128("amount", a.amount);
    assertU128("gasLimit", a.gasLimit);
    if (a.recipient <= 0n || a.recipient >= 1n << 256n)
        throw new Error("recipient out of u256 range");
    if (a.accountFormat !== "evm" && a.accountFormat !== "stellar")
        throw new Error("unknown account format");
    if (a.accountFormat === "evm" && a.recipient >= 1n << 160n)
        throw new Error("recipient is not an EVM address");
    if (a.maxFee < 0n || a.maxFee >= 1n << 256n)
        throw new Error("maxFee out of u256 range");
    return [hex(a.amount), ...u256Felts(a.recipient), ...u256Felts(a.maxFee), hex(a.gasLimit)];
}
/** Both recipient limbs are in invokeCalldataHash, persisted in the proven
 * InvokeSwap.calldata_hash and checked again by invoke_settle. SNIP-12 binds
 * that hash plus the adapter target, chain, pool, action, signer and nonce;
 * exits cannot be replayed in a different adapter/chain domain. The gateway's
 * account format chooses EVM vs Stellar, not the bit-length of the recipient. */
export function planBridgeExit(a) {
    return planSameTokenInvoke({ ...a, target: a.gateway, tail: bridgeExitTail(a), what: "Bridge back" });
}
