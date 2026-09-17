import type { Contract } from "starknet";
import type { VeilReader } from "./discovery.js";
import type { SenderBalanceRules } from "./dvp.js";
import type { VeilERC3643Reader } from "./erc3643.js";
export declare function makeContractReader(contract: Contract): VeilReader;
export declare function makeVeilERC3643ContractReader(contract: Contract): VeilERC3643Reader;
/** The pool's `get_sender_balance_rules(token, holder)`: the rules a DvP post
 *  proof hashes into the order (see VeilDvpMaker.rulesSnapshot). */
export declare function makeSenderBalanceRulesReader(contract: Contract): {
    getSenderBalanceRules(token: bigint, holder: bigint): Promise<SenderBalanceRules>;
};
