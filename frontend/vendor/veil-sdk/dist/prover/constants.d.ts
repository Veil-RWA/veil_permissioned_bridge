/** Host running the Veil prove-and-settle handler. Set `VEIL_PROVER_ENDPOINT`
 *  (e.g. in a .env file) or pass `endpoint` explicitly. Read on each access so
 *  a .env loaded after import still applies. */
export declare function proverEndpointFromEnv(): string | undefined;
/** Prover transport: "sse" for a long-running prover, "job" for a pay-per-use
 *  deployment that runs one container per proof. From `VEIL_PROVER_TRANSPORT`. */
export declare function proverTransportFromEnv(): "sse" | "job" | undefined;
/** Resolve the prover endpoint for a call, preferring an explicit override.
 *  Throws when neither an override nor `VEIL_PROVER_ENDPOINT` is set — better a
 *  clear error than a request to a host the caller did not choose. */
export declare function resolveProverEndpoint(endpoint?: string): string;
/** Account the prover signs with when the caller supplies no `privateKey` +
 *  `senderAddress`. From `VEIL_MASTER_ACCOUNT_ADDRESS`; no default, because a
 *  hardcoded address here would be somebody's real account. */
export declare function resolveMasterAccountAddress(address?: string): string;
/** Starknet JSON-RPC for read-only nonce lookups. From `VEIL_STARKNET_RPC_URL`.
 *  No fallback: the previous public-node default is dead and produced a
 *  confusing "Blast API is no longer available" error at call time. */
export declare function resolveStarknetRpcUrl(rpcUrl?: string): string;
