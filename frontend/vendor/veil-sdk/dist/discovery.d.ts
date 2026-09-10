import { ChannelCiphertext } from "./crypto.js";
export interface OutgoingChannelRecord {
    salt: bigint;
    encryptedRecipient: bigint;
}
export interface SubchannelRecord {
    salt: bigint;
    encryptedCollection: bigint;
}
export interface VeilReader {
    getRecipientChannelsBatch(recipient: bigint, start: number, count: number): Promise<ChannelCiphertext[]>;
    getOutgoingChannelsBatch(ids: bigint[]): Promise<OutgoingChannelRecord[]>;
    getSubchannelsBatch(ids: bigint[]): Promise<SubchannelRecord[]>;
    getNotesBatch(noteIds: bigint[]): Promise<bigint[]>;
    nullifiersUsedBatch(nullifiers: bigint[]): Promise<boolean[]>;
    getPublicViewingKey(user: bigint): Promise<bigint>;
}
export interface DiscoveredChannel {
    channelKey: bigint;
    counterparty: bigint;
    direction: "incoming" | "outgoing";
}
export interface OwnedNft {
    noteId: bigint;
    channelKey: bigint;
    collection: bigint;
    tokenId: bigint;
    noteIndex: number;
    counterparty: bigint;
    direction: "incoming" | "outgoing";
}
export declare class VeilDiscovery {
    private readonly reader;
    private readonly page;
    constructor(reader: VeilReader, page?: number);
    listIncomingChannels(user: bigint, k: bigint): Promise<DiscoveredChannel[]>;
    listOutgoingChannels(user: bigint, k: bigint): Promise<DiscoveredChannel[]>;
    listChannels(user: bigint, k: bigint): Promise<DiscoveredChannel[]>;
    listSubchannels(channelKey: bigint): Promise<{
        collection: bigint;
        index: number;
    }[]>;
    listNotesInSubchannel(channelKey: bigint, collection: bigint): Promise<{
        noteId: bigint;
        tokenId: bigint;
        noteIndex: number;
    }[]>;
    listOwnedNfts(user: bigint, k: bigint): Promise<OwnedNft[]>;
}
