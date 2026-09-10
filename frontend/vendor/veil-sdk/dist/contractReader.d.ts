import type { Contract } from "starknet";
import type { VeilReader } from "./discovery.js";
import type { VeilERC3643Reader } from "./erc3643.js";
export declare function makeContractReader(contract: Contract): VeilReader;
export declare function makeVeilERC3643ContractReader(contract: Contract): VeilERC3643Reader;
