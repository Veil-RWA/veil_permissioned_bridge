// A VeilReader backed by a starknet.js Contract. Wires the key-free batch
// getters on the pool to the discovery scan. Nothing here ever sends a private
// viewing key or channel_key — only public addresses and opaque hashes.
/** Pin every read to a concrete block. starknet.js v6 defaults to
 *  blockIdentifier "pending", which RPC 0.10 rejects outright ("Invalid block
 *  id" — it expects "pre_confirmed"). "latest" is also the right answer for a
 *  reader: scanning notes against a block that may still reorg is worse. */
const LATEST = { blockIdentifier: "latest" };
const toBig = (v) => BigInt(v);
export function makeContractReader(contract) {
    return {
        async getRecipientChannelsBatch(recipient, start, count) {
            const res = (await contract.call("get_recipient_channels_batch", [
                recipient,
                start,
                count,
            ], LATEST));
            return res.map((c) => ({
                ephemeralKeyX: toBig(c.ephemeral_key_x),
                encryptedChannelKey: toBig(c.encrypted_channel_key),
                encryptedSender: toBig(c.encrypted_sender),
            }));
        },
        async getOutgoingChannelsBatch(ids) {
            const res = (await contract.call("get_outgoing_channels_batch", [ids], LATEST));
            return res.map((r) => ({
                salt: toBig(r.salt),
                encryptedRecipient: toBig(r.encrypted_recipient),
            }));
        },
        async getSubchannelsBatch(ids) {
            const res = (await contract.call("get_subchannels_batch", [ids], LATEST));
            return res.map((r) => ({
                salt: toBig(r.salt),
                encryptedCollection: toBig(r.encrypted_collection),
            }));
        },
        async getNotesBatch(noteIds) {
            const res = (await contract.call("get_notes_batch", [noteIds], LATEST));
            return res.map((r) => toBig(r.encrypted_id));
        },
        async nullifiersUsedBatch(nullifiers) {
            const res = (await contract.call("nullifiers_used_batch", [nullifiers], LATEST));
            return res.map((b) => Boolean(b));
        },
        async getPublicViewingKey(user) {
            // get_viewing_key returns (public_viewing_key, EncryptedViewingKey).
            const res = (await contract.call("get_viewing_key", [user], LATEST));
            return toBig(res[0]);
        },
    };
}
// A VeilERC3643Reader backed by a starknet.js Contract for the multi-asset
// fungible pool. Same key-free batch getters, but notes carry `encrypted_amount`
// and subchannels carry `encrypted_token`.
export function makeVeilERC3643ContractReader(contract) {
    return {
        async getRecipientChannelsBatch(recipient, start, count) {
            const res = (await contract.call("get_recipient_channels_batch", [
                recipient,
                start,
                count,
            ], LATEST));
            return res.map((c) => ({
                ephemeralKeyX: toBig(c.ephemeral_key_x),
                encryptedChannelKey: toBig(c.encrypted_channel_key),
                encryptedSender: toBig(c.encrypted_sender),
            }));
        },
        async getSubchannelsBatch(ids) {
            const res = (await contract.call("get_subchannels_batch", [ids], LATEST));
            return res.map((r) => ({
                salt: toBig(r.salt),
                encryptedToken: toBig(r.encrypted_token),
            }));
        },
        async getNotesBatch(noteIds) {
            const res = (await contract.call("get_notes_batch", [noteIds], LATEST));
            return res.map((r) => toBig(r.encrypted_amount));
        },
        async nullifiersUsedBatch(nullifiers) {
            const res = (await contract.call("nullifiers_used_batch", [nullifiers], LATEST));
            return res.map((b) => Boolean(b));
        },
        // note_locked_order is a single getter; loop it (discovery only calls this
        // for the rare open notes, so the fan-out is small).
        async notesLockedBatch(noteIds) {
            const out = [];
            for (const id of noteIds) {
                out.push(toBig(await contract.call("note_locked_order", [id], LATEST)));
            }
            return out;
        },
    };
}
