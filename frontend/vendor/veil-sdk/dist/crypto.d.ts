export declare const TWO_POW_128: bigint;
export declare const MAX_NOTE_SALT_EXCLUSIVE: bigint;
export declare const DOMAIN: {
    readonly NOTE_ID: bigint;
    readonly CHANNEL_MARKER: bigint;
    readonly SUBCHANNEL_MARKER: bigint;
    readonly NULLIFIER: 1n;
    readonly DERIVE_CHANNEL_KEY: 2n;
    readonly OUTGOING_CHANNEL_ID: 4n;
    readonly OUTGOING_RECIPIENT_ENCRYPTION: 5n;
    readonly SUBCHANNEL_ID: 6n;
    readonly SUBCHANNEL_ENCRYPTION: 8n;
    readonly NOTE_ENCRYPTION: 9n;
    readonly CHANNEL_KEY_ENCRYPTION: 10n;
    readonly CHANNEL_SENDER_ENCRYPTION: 11n;
    readonly VIEW_KEY_ENCRYPTION: 12n;
};
export declare const poseidon: (values: bigint[]) => bigint;
export declare const feltAdd: (a: bigint, b: bigint) => bigint;
export declare const feltSub: (a: bigint, b: bigint) => bigint;
export declare const HALF_CURVE_ORDER: bigint;
export declare function viewingKeyAsScalar(k: bigint): bigint;
export declare function derivePublicViewingKey(k: bigint): bigint;
export declare const computeNoteId: (channelKey: bigint, collection: bigint, noteIndex: number) => bigint;
export declare const computeSubchannelId: (channelKey: bigint, subchannelIndex: number) => bigint;
export declare const computeOutgoingChannelId: (sender: bigint, k: bigint, index: number) => bigint;
export declare const deriveNullifier: (channelKey: bigint, collection: bigint, noteIndex: number, k: bigint) => bigint;
export declare const deriveChannelKey: (sender: bigint, k: bigint, recipient: bigint, recipientPubViewingKey: bigint) => bigint;
export interface ChannelCiphertext {
    ephemeralKeyX: bigint;
    encryptedChannelKey: bigint;
    encryptedSender: bigint;
}
export declare function decryptChannel(k: bigint, cipher: ChannelCiphertext): {
    channelKey: bigint;
    sender: bigint;
};
export declare function decryptSubchannelCollection(channelKey: bigint, subchannelIndex: number, salt: bigint, encryptedCollection: bigint): bigint;
export declare function decryptOutgoingRecipient(sender: bigint, k: bigint, index: number, salt: bigint, encryptedRecipient: bigint): bigint;
export declare function decryptNftId(channelKey: bigint, collection: bigint, noteIndex: number, encryptedId: bigint): bigint;
export declare function decryptNoteAmount(channelKey: bigint, token: bigint, noteIndex: number, encryptedAmount: bigint): bigint;
