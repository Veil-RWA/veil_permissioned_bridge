// Fungible-balance discovery for the multi-asset ERC-3643 Veil pool, run
// entirely on the user's device (the viewing key `k` never leaves the process).
//
// A user's spendable balance for a token is the sum of UNSPENT note amounts the
// user OWNS. The user owns the notes in their INCOMING channels —
// recipient_channels[user] — which already includes the self-channel where
// deposits and transfer change land (it is opened as recipient_channels[user][0]
// at registration). This mirrors VeilERC3643.select_input_notes_internal
// exactly, so the SDK's balance equals the balance the contract will spend from.
//
// Notes in the user's OUTGOING channels are owned by their counterparties (the
// user cannot compute their nullifiers), so they are intentionally NOT counted.
import { computeNoteId, computeSubchannelId, decryptChannel, decryptNoteAmount, decryptSubchannelCollection, deriveNullifier, } from "./crypto.js";
import { classifyNote } from "./dvp.js";
const DEFAULT_PAGE = 64;
export class VeilERC3643Discovery {
    reader;
    page;
    constructor(reader, page = DEFAULT_PAGE) {
        this.reader = reader;
        this.page = page;
    }
    // Incoming channels = recipient_channels[user][0..] until an empty slot
    // (STRK20 Theorem 1: contiguous). Decrypt each to (channel_key, sender).
    async listIncomingChannels(user, k) {
        const out = [];
        let start = 0;
        for (;;) {
            const batch = await this.reader.getRecipientChannelsBatch(user, start, this.page);
            let stop = false;
            for (const cipher of batch) {
                if (cipher.ephemeralKeyX === 0n) {
                    stop = true;
                    break;
                }
                const { channelKey, sender } = decryptChannel(k, cipher);
                out.push({ channelKey, sender });
            }
            if (stop || batch.length < this.page)
                break;
            start += this.page;
        }
        return out;
    }
    // subchannel_id = H6(channel_key, ℓ); decrypt each to its token address.
    async listSubchannels(channelKey) {
        const out = [];
        let l = 0;
        for (;;) {
            const ids = Array.from({ length: this.page }, (_, i) => computeSubchannelId(channelKey, l + i));
            const records = await this.reader.getSubchannelsBatch(ids);
            let stop = false;
            for (let i = 0; i < records.length; i++) {
                const rec = records[i];
                if (rec.encryptedToken === 0n) {
                    stop = true;
                    break;
                }
                const token = decryptSubchannelCollection(channelKey, l + i, rec.salt, rec.encryptedToken);
                out.push({ token, index: l + i });
            }
            if (stop)
                break;
            l += this.page;
        }
        return out;
    }
    // note_id = H0(channel_key, token, i). Reads each note's spendable amount.
    // Mirrors read_note_amount_internal (§10.6):
    //   * regular note      → decrypt the hash-masked amount.
    //   * OPEN note (salt=1) → plaintext amount; an UNFILLED one (amount 0) is
    //     skipped (not spendable, its nullifier must not be burned).
    // A note LOCKED to an OPEN DvP order (its in-flight receive note) is excluded
    // when the reader exposes `notesLockedBatch`.
    async listNotesInSubchannel(channelKey, token) {
        const out = [];
        let i = 0;
        for (;;) {
            const noteIds = Array.from({ length: this.page }, (_, j) => computeNoteId(channelKey, token, i + j));
            const encs = await this.reader.getNotesBatch(noteIds);
            // Resolve locks for the open notes in this page (the only ones that can be
            // locked to an order), if the reader supports it.
            const openIdx = encs
                .map((enc, j) => ({ enc, j }))
                .filter(({ enc }) => classifyNote(enc).kind === "open")
                .map(({ j }) => j);
            let lockedSet = new Set();
            if (openIdx.length > 0 && this.reader.notesLockedBatch) {
                const locks = await this.reader.notesLockedBatch(openIdx.map((j) => noteIds[j]));
                lockedSet = new Set(openIdx.filter((_, k) => locks[k] !== 0n));
            }
            let stop = false;
            for (let j = 0; j < encs.length; j++) {
                const note = classifyNote(encs[j]);
                if (note.kind === "empty") {
                    stop = true;
                    break;
                }
                if (note.kind === "open") {
                    // Unfilled or in-flight (locked) → not spendable.
                    if (note.amount === 0n || lockedSet.has(j))
                        continue;
                    out.push({ noteId: noteIds[j], amount: note.amount, noteIndex: i + j });
                    continue;
                }
                const amount = decryptNoteAmount(channelKey, token, i + j, encs[j]);
                out.push({ noteId: noteIds[j], amount, noteIndex: i + j });
            }
            if (stop)
                break;
            i += this.page;
        }
        return out;
    }
    // Every UNSPENT note the user can spend, with decrypted amount + token.
    async listOwnedNotes(user, k) {
        const channels = await this.listIncomingChannels(user, k);
        const candidates = [];
        for (const ch of channels) {
            const subs = await this.listSubchannels(ch.channelKey);
            for (const sub of subs) {
                const notes = await this.listNotesInSubchannel(ch.channelKey, sub.token);
                for (const n of notes) {
                    candidates.push({
                        noteId: n.noteId,
                        channelKey: ch.channelKey,
                        token: sub.token,
                        amount: n.amount,
                        noteIndex: n.noteIndex,
                        sender: ch.sender,
                        nullifier: deriveNullifier(ch.channelKey, sub.token, n.noteIndex, k),
                    });
                }
            }
        }
        const owned = [];
        for (let off = 0; off < candidates.length; off += this.page) {
            const slice = candidates.slice(off, off + this.page);
            const spent = await this.reader.nullifiersUsedBatch(slice.map((c) => c.nullifier));
            slice.forEach((c, idx) => {
                if (!spent[idx]) {
                    const { nullifier, ...note } = c;
                    owned.push(note);
                }
            });
        }
        return owned;
    }
    // Aggregated spendable balance per token.
    async getBalances(user, k) {
        const notes = await this.listOwnedNotes(user, k);
        const map = new Map();
        for (const n of notes) {
            const cur = map.get(n.token) ?? { balance: 0n, noteCount: 0 };
            cur.balance += n.amount;
            cur.noteCount += 1;
            map.set(n.token, cur);
        }
        return [...map.entries()].map(([token, v]) => ({
            token,
            balance: v.balance,
            noteCount: v.noteCount,
        }));
    }
    // Spendable balance for a single token.
    async getBalance(user, k, token) {
        const notes = await this.listOwnedNotes(user, k);
        let total = 0n;
        for (const n of notes)
            if (n.token === token)
                total += n.amount;
        return total;
    }
}
