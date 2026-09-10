import type { VeilEvent, VeilProveAndSettleInput, VeilProveAndSettleResult } from "./types.js";
/** Thrown when the prover service returns a non-2xx HTTP response. */
export declare class ProverHttpError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, statusText: string, body: string);
}
/** Thrown when the prover service emits an `error` SSE event. */
export declare class ProverServerError extends Error {
    constructor(message: string);
}
/** Stream the SSE events from `POST /api/veil/prove-and-settle` as an async
 *  iterable. Each yielded item is a typed `VeilEvent`.
 *
 *  The server proves `<operation>_derive` in the virtual OS, reads the derived
 *  L2->L1 message, assembles `<operation>_settle` calldata, and submits it via
 *  the sequencer gateway carrying the derive's proof + proof_facts. */
export declare function veilProveAndSettleStream(input: VeilProveAndSettleInput): AsyncGenerator<VeilEvent, void, void>;
/** Convenience wrapper: drives the stream to completion, surfacing each event
 *  via `onEvent` (optional) and returning the final result.
 *
 *  Throws on `error` SSE events or HTTP errors. */
export declare function veilProveAndSettle(input: VeilProveAndSettleInput & {
    onEvent?: (event: VeilEvent) => void;
}): Promise<VeilProveAndSettleResult>;
