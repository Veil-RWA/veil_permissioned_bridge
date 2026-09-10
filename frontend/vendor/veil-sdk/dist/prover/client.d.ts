import type { ProveAndSubmitEvent, ProveAndSubmitInput, ProveAndSubmitResult } from "./types.js";
/** Stream the SSE events from `POST /api/prove-and-submit` as an async
 *  iterable. Each yielded item is a typed `ProveAndSubmitEvent`. */
export declare function proveAndSubmitStream(input: ProveAndSubmitInput): AsyncGenerator<ProveAndSubmitEvent, void, void>;
/** Convenience wrapper: drives the stream to completion, surfacing each event
 *  via `onEvent` (optional) and returning the final result.
 *
 *  Throws on `error` SSE events or HTTP errors. */
export declare function proveAndSubmit(input: ProveAndSubmitInput & {
    onEvent?: (event: ProveAndSubmitEvent) => void;
}): Promise<ProveAndSubmitResult>;
export declare class ProveAndSubmitHttpError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, statusText: string, body: string);
}
export declare class ProveAndSubmitServerError extends Error {
    constructor(message: string);
}
