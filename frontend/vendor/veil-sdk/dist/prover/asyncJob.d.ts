import type { VeilEvent, VeilProveAndSettleInput, VeilProveAndSettleResult } from "./types.js";
export interface VeilJobOptions {
    /** Poll interval in ms (default 5000). */
    pollIntervalMs?: number;
    /** Give up after this long (default 30 min — a cold start plus a proof). */
    timeoutMs?: number;
}
/** Submit a proving job and poll until it finishes. */
export declare function veilProveAndSettleJob(input: VeilProveAndSettleInput & {
    nonceResolved: string;
    onEvent?: (event: VeilEvent) => void;
} & VeilJobOptions): Promise<VeilProveAndSettleResult>;
