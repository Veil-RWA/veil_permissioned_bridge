import { resolveMasterAccountAddress, resolveProverEndpoint } from "./constants.js";
import { getNonce } from "./nonce.js";
import { readSseRecord, safeJson } from "./sse.js";
/** Thrown when the prover service returns a non-2xx HTTP response. */
export class ProverHttpError extends Error {
    status;
    body;
    constructor(status, statusText, body) {
        super(`HTTP ${status} ${statusText}: ${body.slice(0, 500)}`);
        this.status = status;
        this.body = body;
        this.name = "ProverHttpError";
    }
}
/** Thrown when the prover service emits an `error` SSE event. */
export class ProverServerError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProverServerError";
    }
}
/** Stream the SSE events from `POST /api/veil/prove-and-settle` as an async
 *  iterable. Each yielded item is a typed `VeilEvent`.
 *
 *  The server proves `<operation>_derive` in the virtual OS, reads the derived
 *  L2->L1 message, assembles `<operation>_settle` calldata, and submits it via
 *  the sequencer gateway carrying the derive's proof + proof_facts. */
export async function* veilProveAndSettleStream(input) {
    const endpoint = resolveProverEndpoint(input.endpoint);
    const url = new URL("/api/veil/prove-and-settle", endpoint).toString();
    const nonce = await resolveNonce(input);
    const body = {
        operation: input.operation,
        veil_address: input.veilAddress,
        derive_calldata: input.deriveCalldata,
        nonce,
    };
    if (input.pool !== undefined)
        body.pool = input.pool;
    if (input.settleExtra !== undefined)
        body.settle_extra = input.settleExtra;
    if (input.blockNumber !== undefined)
        body.block_number = input.blockNumber;
    if (input.privateKey !== undefined)
        body.private_key = input.privateKey;
    if (input.senderAddress !== undefined)
        body.sender_address = input.senderAddress;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: input.signal,
    });
    if (!resp.ok) {
        const text = await safeText(resp);
        throw new ProverHttpError(resp.status, resp.statusText, text);
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
                    const ev = parseVeilRecord(buffer);
                    if (ev)
                        yield ev;
                }
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = nextRecordEnd(buffer)) >= 0) {
                const record = buffer.slice(0, idx);
                const sep = buffer.startsWith("\r\n\r\n", idx) ? 4 : 2;
                buffer = buffer.slice(idx + sep);
                const ev = parseVeilRecord(record);
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
export async function veilProveAndSettle(input) {
    // Pay-per-use deployments launch a container per proof and cannot hold an SSE
    // connection open, so they expose submit/poll instead. Same result either way.
    if (input.transport === "job") {
        const { veilProveAndSettleJob } = await import("./asyncJob.js");
        return veilProveAndSettleJob({ ...input, nonceResolved: await resolveNonce(input) });
    }
    for await (const event of veilProveAndSettleStream(input)) {
        input.onEvent?.(event);
        if (event.type === "complete")
            return event.result;
        if (event.type === "error")
            throw new ProverServerError(event.message);
    }
    throw new Error("server stream ended without `complete` or `error` event");
}
function parseVeilRecord(record) {
    const rec = readSseRecord(record);
    if (!rec)
        return null;
    switch (rec.event) {
        case "phase":
            return { type: "phase", phase: rec.data };
        case "log":
            return { type: "log", line: rec.data };
        case "program_hash": {
            const parsed = safeJson(rec.data);
            if (!parsed)
                return null;
            return { type: "program_hash", programHash: String(parsed.virtual_os_program_hash) };
        }
        case "complete": {
            const parsed = safeJson(rec.data);
            if (!parsed)
                return null;
            return {
                type: "complete",
                result: {
                    operation: String(parsed.operation),
                    txHash: String(parsed.tx_hash),
                    localTxHash: String(parsed.local_tx_hash),
                    referenceBlock: Number(parsed.reference_block),
                    proofDurationSecs: Number(parsed.proof_duration_secs),
                    settleCalldataLen: Number(parsed.settle_calldata_len),
                },
            };
        }
        case "error":
            return { type: "error", message: rec.data };
        default:
            return null;
    }
}
/** Fill the nonce if the caller omitted it. When a `privateKey` is supplied we
 *  refuse to silently fetch a nonce for the wrong account — `senderAddress`
 *  must be present. Otherwise we fetch the master account's nonce. */
async function resolveNonce(input) {
    if (input.nonce !== undefined)
        return input.nonce;
    if (input.privateKey !== undefined) {
        if (!input.senderAddress) {
            throw new Error("nonce is required when you supply your own privateKey + senderAddress");
        }
        return await getNonce(input.senderAddress, input.rpcUrl);
    }
    return await getNonce(resolveMasterAccountAddress(input.masterAddress), input.rpcUrl);
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
