// Async (job-queue) transport for the prover service.
//
// The SSE transport in ./veil.ts holds one HTTP connection open for the whole
// proof. That works against a long-running prover, but not against a
// pay-per-use deployment where each proof runs in a container that is launched
// on demand and exits when done: there is nothing to hold a connection to
// before the task starts, and an API-Gateway-fronted service caps a request
// well below proof duration.
//
// This transport submits the job, then polls:
//
//     POST {endpoint}/prove      -> { jobId }
//     GET  {endpoint}/jobs/{id}  -> { status, result | error }
//
// The result shape is identical to the SSE transport's, so callers (including
// VeilXSwapClient) are unaffected by which one is in use.
import { ProverServerError } from "./veil.js";
/** Terminal + in-flight states the job API reports. */
const DONE = "SUCCEEDED";
const FAILED = "FAILED";
function jobBody(input, nonce) {
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
    return body;
}
/** Map the job record's `result` onto the same shape the SSE transport returns. */
function toResult(operation, r) {
    return {
        operation: String(r.operation ?? operation),
        txHash: String(r.tx_hash),
        localTxHash: String(r.local_tx_hash),
        referenceBlock: Number(r.reference_block),
        proofDurationSecs: Number(r.proof_duration_secs),
        settleCalldataLen: Number(r.settle_calldata_len),
    };
}
/** Submit a proving job and poll until it finishes. */
export async function veilProveAndSettleJob(input) {
    const endpoint = input.endpoint;
    if (!endpoint)
        throw new Error("endpoint is required for the job transport");
    const pollMs = input.pollIntervalMs ?? 5000;
    const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;
    const emit = (e) => input.onEvent?.(e);
    const submit = await fetch(new URL("/prove", endpoint).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(jobBody(input, input.nonceResolved)),
        signal: input.signal,
    });
    const submitted = (await submit.json().catch(() => ({})));
    if (!submit.ok || !submitted.jobId) {
        throw new ProverServerError(`job submission failed (HTTP ${submit.status}): ${JSON.stringify(submitted)}`);
    }
    const jobId = String(submitted.jobId);
    emit({ type: "phase", phase: `submitted job ${jobId}` });
    const started = Date.now();
    for (;;) {
        if (Date.now() - started > timeoutMs) {
            throw new ProverServerError(`job ${jobId} did not finish within ${timeoutMs} ms`);
        }
        await new Promise((r) => setTimeout(r, pollMs));
        const res = await fetch(new URL(`/jobs/${jobId}`, endpoint).toString(), {
            signal: input.signal,
        });
        const job = (await res.json().catch(() => ({})));
        if (!res.ok) {
            throw new ProverServerError(`job poll failed (HTTP ${res.status})`);
        }
        const status = String(job.status ?? "UNKNOWN");
        if (status === DONE) {
            const r = job.result;
            if (!r || r.tx_hash === undefined) {
                throw new ProverServerError(`job ${jobId} succeeded without a tx hash`);
            }
            const result = toResult(input.operation, r);
            emit({ type: "complete", result });
            return result;
        }
        if (status === FAILED) {
            throw new ProverServerError(String(job.error ?? `job ${jobId} failed`));
        }
        emit({
            type: "phase",
            phase: `${status.toLowerCase()} (${Math.round((Date.now() - started) / 1000)}s)`,
        });
    }
}
