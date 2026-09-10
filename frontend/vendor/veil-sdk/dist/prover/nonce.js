import { RpcProvider } from "starknet";
import { resolveMasterAccountAddress, resolveStarknetRpcUrl } from "./constants.js";
// One RpcProvider per RPC URL (read-only nonce lookups).
const providers = new Map();
function rpc(rpcUrl) {
    let p = providers.get(rpcUrl);
    if (!p) {
        p = new RpcProvider({ nodeUrl: rpcUrl });
        providers.set(rpcUrl, p);
    }
    return p;
}
/** Fetch the on-chain nonce for an account. Returns the hex-encoded nonce
 *  (`"0x..."`). Address and RPC fall back to VEIL_MASTER_ACCOUNT_ADDRESS and
 *  VEIL_STARKNET_RPC_URL; both throw a clear error if unset. */
export async function getNonce(address, rpcUrl) {
    return await rpc(resolveStarknetRpcUrl(rpcUrl)).getNonceForAddress(resolveMasterAccountAddress(address), "latest");
}
