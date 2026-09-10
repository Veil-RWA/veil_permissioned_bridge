import { DEFAULT_MASTER_ACCOUNT_ADDRESS, DEFAULT_PROVER_ENDPOINT } from "./constants.js";
import { getNonce } from "./nonce.js";
import { parseSseRecord } from "./sse.js";
/** Stream the SSE events from `POST /api/prove-and-submit` as an async
 *  iterable. Each yielded item is a typed `ProveAndSubmitEvent`. */
export async function* proveAndSubmitStream(input) {
    const endpoint = input.endpoint ?? DEFAULT_PROVER_ENDPOINT;
    const url = new URL("/api/prove-and-submit", endpoint).toString();
    const unsignedTx = await fillNonceIfMissing(input);
    const body = { unsigned_tx: unsignedTx };
    if (input.blockNumber !== undefined)
        body.block_number = input.blockNumber;
    if (input.privateKey !== undefined)
        body.private_key = input.privateKey;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: input.signal,
    });
    if (!resp.ok) {
        const text = await safeText(resp);
        throw new ProveAndSubmitHttpError(resp.status, resp.statusText, text);
    }
    if (!resp.body)
        throw new Error("response has no body");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                if (buffer.length > 0) {
                    const ev = parseSseRecord(buffer);
                    if (ev)
                        yield ev;
                }
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = nextRecordEnd(buffer)) >= 0) {
                const record = buffer.slice(0, idx);
                // Skip the \n\n or \r\n\r\n separator.
                const sep = buffer.startsWith("\r\n\r\n", idx) ? 4 : 2;
                buffer = buffer.slice(idx + sep);
                const ev = parseSseRecord(record);
                if (ev)
                    yield ev;
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
/** Convenience wrapper: drives the stream to completion, surfacing each event
 *  via `onEvent` (optional) and returning the final result.
 *
 *  Throws on `error` SSE events or HTTP errors. */
export async function proveAndSubmit(input) {
    for await (const event of proveAndSubmitStream(input)) {
        input.onEvent?.(event);
        if (event.type === "complete")
            return event.result;
        if (event.type === "error")
            throw new ProveAndSubmitServerError(event.message);
    }
    throw new Error("server stream ended without `complete` or `error` event");
}
export class ProveAndSubmitHttpError extends Error {
    status;
    body;
    constructor(status, statusText, body) {
        super(`HTTP ${status} ${statusText}: ${body.slice(0, 500)}`);
        this.status = status;
        this.body = body;
        this.name = "ProveAndSubmitHttpError";
    }
}
export class ProveAndSubmitServerError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProveAndSubmitServerError";
    }
}
/** If the caller didn't supply a nonce, fetch the current on-chain nonce for
 *  the relevant address: the supplied `sender_address` if they passed one,
 *  otherwise the master account that the server signs with. When the caller
 *  supplied their own `privateKey`, we refuse to silently fetch a nonce for
 *  the wrong account — they must supply their own. */
async function fillNonceIfMissing(input) {
    const tx = input.unsignedTx;
    if (tx.nonce !== undefined)
        return tx;
    if (input.privateKey !== undefined) {
        if (!tx.sender_address) {
            throw new Error("unsignedTx.nonce is required when you supply your own privateKey + sender_address");
        }
        const nonce = await getNonce(tx.sender_address, input.rpcUrl);
        return { ...tx, nonce };
    }
    // Server-side fallback signing path: fetch the master account's nonce.
    const nonce = await getNonce(input.masterAddress ?? DEFAULT_MASTER_ACCOUNT_ADDRESS, input.rpcUrl);
    return { ...tx, nonce };
}
function nextRecordEnd(buf) {
    const a = buf.indexOf("\n\n");
    const b = buf.indexOf("\r\n\r\n");
    if (a < 0)
        return b;
    if (b < 0)
        return a;
    return Math.min(a, b);
}
async function safeText(resp) {
    try {
        return await resp.text();
    }
    catch {
        return "";
    }
}
