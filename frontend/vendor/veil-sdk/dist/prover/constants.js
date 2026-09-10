// Configuration for the SNIP-36 prover service.
//
// Nothing here is a host, account, or credential of ours. Every value comes
// from the environment or from explicit config; there are no baked-in defaults
// that would silently point a deployment at someone else's infrastructure.
//
// Env is read LAZILY, at the point of use rather than at module load. Reading
// it at load time means `dotenv.config()` has to run before the very first
// `import` of this package, which is a trap: the import is usually hoisted
// above the dotenv call and the value silently comes back undefined.
/** Read an env var without requiring `@types/node` — returns `undefined` in a
 *  browser, where `process` does not exist. */
function readEnv(name) {
    const env = globalThis
        .process?.env;
    const v = env?.[name];
    return v && v.length > 0 ? v : undefined;
}
/** Host running the Veil prove-and-settle handler. Set `VEIL_PROVER_ENDPOINT`
 *  (e.g. in a .env file) or pass `endpoint` explicitly. Read on each access so
 *  a .env loaded after import still applies. */
export function proverEndpointFromEnv() {
    return readEnv("VEIL_PROVER_ENDPOINT");
}
/** Prover transport: "sse" for a long-running prover, "job" for a pay-per-use
 *  deployment that runs one container per proof. From `VEIL_PROVER_TRANSPORT`. */
export function proverTransportFromEnv() {
    const v = readEnv("VEIL_PROVER_TRANSPORT");
    return v === "sse" || v === "job" ? v : undefined;
}
/** Resolve the prover endpoint for a call, preferring an explicit override.
 *  Throws when neither an override nor `VEIL_PROVER_ENDPOINT` is set — better a
 *  clear error than a request to a host the caller did not choose. */
export function resolveProverEndpoint(endpoint) {
    const resolved = endpoint ?? proverEndpointFromEnv();
    if (!resolved) {
        throw new Error("no prover endpoint configured — set VEIL_PROVER_ENDPOINT (see .env.example) " +
            "or pass `endpoint` to the VeilProver config / call options");
    }
    return resolved;
}
/** Account the prover signs with when the caller supplies no `privateKey` +
 *  `senderAddress`. From `VEIL_MASTER_ACCOUNT_ADDRESS`; no default, because a
 *  hardcoded address here would be somebody's real account. */
export function resolveMasterAccountAddress(address) {
    const resolved = address ?? readEnv("VEIL_MASTER_ACCOUNT_ADDRESS");
    if (!resolved) {
        throw new Error("no master account configured — set VEIL_MASTER_ACCOUNT_ADDRESS, or pass " +
            "`masterAddress` (or `senderAddress` + `privateKey`) explicitly");
    }
    return resolved;
}
/** Starknet JSON-RPC for read-only nonce lookups. From `VEIL_STARKNET_RPC_URL`.
 *  No fallback: the previous public-node default is dead and produced a
 *  confusing "Blast API is no longer available" error at call time. */
export function resolveStarknetRpcUrl(rpcUrl) {
    const resolved = rpcUrl ?? readEnv("VEIL_STARKNET_RPC_URL") ?? readEnv("RPC_URL");
    if (!resolved) {
        throw new Error("no Starknet RPC configured — set VEIL_STARKNET_RPC_URL (or RPC_URL), " +
            "or pass `rpcUrl` to the VeilProver config");
    }
    return resolved;
}
