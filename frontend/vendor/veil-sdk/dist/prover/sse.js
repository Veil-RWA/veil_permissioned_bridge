/** Split one SSE record (the chunk between two `\n\n`s) into its `event` name
 *  and accumulated `data`. Returns null if the record carries no data. */
export function readSseRecord(record) {
    let event = "message";
    let data = "";
    for (const rawLine of record.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith(":"))
            continue;
        const colon = line.indexOf(":");
        if (colon < 0)
            continue;
        const field = line.slice(0, colon);
        const value = line.slice(colon + 1).replace(/^ /, "");
        if (field === "event")
            event = value;
        else if (field === "data")
            data = data ? `${data}\n${value}` : value;
    }
    if (!data)
        return null;
    return { event, data };
}
export function safeJson(s) {
    try {
        const v = JSON.parse(s);
        return typeof v === "object" && v !== null ? v : null;
    }
    catch {
        return null;
    }
}
