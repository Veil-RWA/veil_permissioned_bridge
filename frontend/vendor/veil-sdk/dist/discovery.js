// STRK20 §5.4 note discovery, run entirely on the user's device.
//
// The flow: scan incoming + outgoing channels → subchannels → notes, decrypting
// each layer locally with the viewing key `k`. The only things sent to the RPC
// are PUBLIC addresses and OPAQUE hashes (note_id / subchannel_id /
// outgoing_channel_id / nullifier) that we computed locally. `k` and every
// derived `channel_key` stay in this process. See the key-free batch getters in
// src/Veil.cairo (get_*_batch / nullifiers_used_batch).
import { computeNoteId, computeOutgoingChannelId, computeSubchannelId, decryptChannel, decryptNftId, decryptOutgoingRecipient, decryptSubchannelCollection, deriveChannelKey, deriveNullifier, } from "./crypto.js";
const DEFAULT_PAGE = 64;
export class VeilDiscovery {
    reader;
    page;
    constructor(reader, page = DEFAULT_PAGE) {
        this.reader = reader;
        this.page = page;
    }
    // ── Channels ───────────────────────────────────────────────────────────────
    // Incoming: scan recipient_channels[user][0..] until an empty slot, decrypt
    // each ciphertext to (channel_key, sender). STRK20 §5.1.1 / Theorem 1
    // guarantees contiguous slots, so the first empty slot terminates the scan.
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
                out.push({ channelKey, counterparty: sender, direction: "incoming" });
            }
            if (stop || batch.length < this.page)
                break;
            start += this.page;
        }
        return out;
    }
    // Outgoing: outgoing_channel_id = H4(user, k, q) for q = 0,1,…; fetch records
    // until empty, decrypt the recipient, then derive the channel key (needs the
    // recipient's PUBLIC viewing key, fetched on-chain). STRK20 §5.1.4.
    async listOutgoingChannels(user, k) {
        const out = [];
        let q = 0;
        for (;;) {
            const ids = Array.from({ length: this.page }, (_, i) => computeOutgoingChannelId(user, k, q + i));
            const records = await this.reader.getOutgoingChannelsBatch(ids);
            let stop = false;
            for (let i = 0; i < records.length; i++) {
                const rec = records[i];
                if (rec.encryptedRecipient === 0n) {
                    stop = true;
                    break;
                }
                const recipient = decryptOutgoingRecipient(user, k, q + i, rec.salt, rec.encryptedRecipient);
                const recipientPub = await this.reader.getPublicViewingKey(recipient);
                const channelKey = deriveChannelKey(user, k, recipient, recipientPub);
                out.push({ channelKey, counterparty: recipient, direction: "outgoing" });
            }
            if (stop)
                break;
            q += this.page;
        }
        return out;
    }
    async listChannels(user, k) {
        const incoming = await this.listIncomingChannels(user, k);
        const outgoing = await this.listOutgoingChannels(user, k);
        // De-dup by channel_key (a self-channel can surface on both sides).
        const seen = new Set();
        const merged = [];
        for (const ch of [...incoming, ...outgoing]) {
            if (seen.has(ch.channelKey))
                continue;
            seen.add(ch.channelKey);
            merged.push(ch);
        }
        return merged;
    }
    // ── Subchannels: subchannel_id = H6(channel_key, ℓ) for ℓ = 0,1,… ───────────
    async listSubchannels(channelKey) {
        const out = [];
        let l = 0;
        for (;;) {
            const ids = Array.from({ length: this.page }, (_, i) => computeSubchannelId(channelKey, l + i));
            const records = await this.reader.getSubchannelsBatch(ids);
            let stop = false;
            for (let i = 0; i < records.length; i++) {
                const rec = records[i];
                if (rec.encryptedCollection === 0n) {
                    stop = true;
                    break;
                }
                const collection = decryptSubchannelCollection(channelKey, l + i, rec.salt, rec.encryptedCollection);
                out.push({ collection, index: l + i });
            }
            if (stop)
                break;
            l += this.page;
        }
        return out;
    }
    // ── Notes: note_id = H0(channel_key, collection, i) for i = 0,1,… ───────────
    // Returns every note in the subchannel (spent + unspent); spend status is
    // resolved separately so we batch the nullifier lookups.
    async listNotesInSubchannel(channelKey, collection) {
        const out = [];
        let i = 0;
        for (;;) {
            const noteIds = Array.from({ length: this.page }, (_, j) => computeNoteId(channelKey, collection, i + j));
            const encryptedIds = await this.reader.getNotesBatch(noteIds);
            let stop = false;
            for (let j = 0; j < encryptedIds.length; j++) {
                const enc = encryptedIds[j];
                if (enc === 0n) {
                    stop = true;
                    break;
                }
                const tokenId = decryptNftId(channelKey, collection, i + j, enc);
                out.push({ noteId: noteIds[j], tokenId, noteIndex: i + j });
            }
            if (stop)
                break;
            i += this.page;
        }
        return out;
    }
    // ── Top-level: every UNSPENT NFT the user holds in the pool ─────────────────
    async listOwnedNfts(user, k) {
        const channels = await this.listChannels(user, k);
        const candidates = [];
        for (const ch of channels) {
            const subs = await this.listSubchannels(ch.channelKey);
            for (const sub of subs) {
                const notes = await this.listNotesInSubchannel(ch.channelKey, sub.collection);
                for (const n of notes) {
                    candidates.push({
                        noteId: n.noteId,
                        channelKey: ch.channelKey,
                        collection: sub.collection,
                        tokenId: n.tokenId,
                        noteIndex: n.noteIndex,
                        counterparty: ch.counterparty,
                        direction: ch.direction,
                        nullifier: deriveNullifier(ch.channelKey, sub.collection, n.noteIndex, k),
                    });
                }
            }
        }
        // 2) Resolve spend status in batches and keep only unspent notes.
        const owned = [];
        for (let off = 0; off < candidates.length; off += this.page) {
            const slice = candidates.slice(off, off + this.page);
            const spent = await this.reader.nullifiersUsedBatch(slice.map((c) => c.nullifier));
            slice.forEach((c, idx) => {
                if (!spent[idx]) {
                    const { nullifier, ...nft } = c;
                    owned.push(nft);
                }
            });
        }
        return owned;
    }
}
