import { ChannelCiphertext } from "./crypto.js";
export interface ERC3643SubchannelRecord {
    salt: bigint;
    encryptedToken: bigint;
}
export interface VeilERC3643Reader {
    getRecipientChannelsBatch(recipient: bigint, start: number, count: number): Promise<ChannelCiphertext[]>;
    getSubchannelsBatch(ids: bigint[]): Promise<ERC3643SubchannelRecord[]>;
    getNotesBatch(noteIds: bigint[]): Promise<bigint[]>;
    nullifiersUsedBatch(nullifiers: bigint[]): Promise<boolean[]>;
    /** note_id -> order_id locking it (0 ⇒ unlocked). Optional. */
    notesLockedBatch?(noteIds: bigint[]): Promise<bigint[]>;
}
export interface OwnedNote {
    noteId: bigint;
    channelKey: bigint;
    token: bigint;
    amount: bigint;
    noteIndex: number;
    sender: bigint;
}
export interface TokenBalance {
    token: bigint;
    balance: bigint;
    noteCount: number;
}
export declare class VeilERC3643Discovery {
    private readonly reader;
    private readonly page;
    constructor(reader: VeilERC3643Reader, page?: number);
    private listIncomingChannels;
    private listSubchannels;
    private listNotesInSubchannel;
    listOwnedNotes(user: bigint, k: bigint): Promise<OwnedNote[]>;
    getBalances(user: bigint, k: bigint): Promise<TokenBalance[]>;
    getBalance(user: bigint, k: bigint, token: bigint): Promise<bigint>;
}
