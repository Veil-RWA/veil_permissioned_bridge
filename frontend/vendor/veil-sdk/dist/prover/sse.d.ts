/** Split one SSE record (the chunk between two `\n\n`s) into its `event` name
 *  and accumulated `data`. Returns null if the record carries no data. */
export declare function readSseRecord(record: string): {
    event: string;
    data: string;
} | null;
export declare function safeJson(s: string): Record<string, unknown> | null;
