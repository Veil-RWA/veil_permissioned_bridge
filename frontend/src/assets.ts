// The assets this bridge carries.
//
// One lockbox and one twin PER ASSET -- the ESCROW is never shared, because a
// shared lockbox would let one issuer's pause or compromise reach another
// issuer's holders, and would blur the escrow invariant. So each entry here
// carries its own contract set, filled in by the deployment scripts.
//
// The Veil POOL on the far side is the opposite: one pool carries any number of
// assets, so it is shared and lives in the deployment config rather than here.
// See pools.ts -- which pool a transfer lands in is the user's choice, not a
// property of the instrument.
//
// This file is the catalogue: identity, display and decimals, which are
// properties of the instrument rather than of any one deployment. Addresses
// come from ../deployments/<pair>.json under `assets.<id>`, so the same
// catalogue serves testnet and mainnet without edits.
//
// An asset with no addresses in the current deployment still appears, marked
// unavailable. Hiding it would leave a user wondering whether the bridge
// supports their instrument at all; showing it greyed out answers that.

import { deployment } from './config';

export type AssetCategory = 'Metal' | 'Treasury' | 'Credit' | 'Real estate' | 'Equity' | 'Security';

export type AssetMeta = {
  id: string;
  symbol: string;
  name: string;
  category: AssetCategory;
  /** Base units. Overridden by the token's own decimals() once read. */
  decimals: number;
  /** Two-stop gradient for the token mark. */
  tint: [string, string];
};

export type AssetAddresses = {
  evm?: {
    lockbox?: string; token?: string; complianceReader?: string;
    /// Where holder eligibility lives on the source chain. Absent means
    /// ERC-3643, which every deployment before allowlisted assets was.
    kind?: 'erc3643' | 'allowlist' | 'rules' | 'securitize';
    /// The allowlist an allowlisted asset's lockbox reads. Recorded for
    /// operators; the app asks the lockbox itself.
    allowlist?: string;
    /// A faucet in front of the token (eToro, Securitize), when the token is
    /// not its own faucet.
    faucet?: string;
  };
  starknet?: {
    token?: string; gateway?: string; registry?: string; compliance?: string; pool?: string;
    /// MirroredTransferRules: what the Veil pool reads for an allowlisted twin.
    rules?: string;
  };
};

export type Asset = AssetMeta & {
  addresses: AssetAddresses;
  /** Every contract this asset needs is deployed and wired. */
  available: boolean;
  /** A Veil pool is configured, so a transfer may be addressed to a note. */
  poolReady: boolean;
};

/// Instrument types, not products: an ERC-3643 asset belongs to its issuer, and
/// the bridge is issuer-agnostic. A deployment maps each id to whichever token
/// the issuer actually deployed.
export const CATALOGUE: AssetMeta[] = [
  {
    id: 'gold',
    symbol: 'XAU',
    name: 'Tokenized gold',
    category: 'Metal',
    decimals: 18,
    tint: ['#f0dcae', '#d9a03f'],
  },
  {
    id: 'silver',
    symbol: 'XAG',
    name: 'Tokenized silver',
    category: 'Metal',
    decimals: 18,
    tint: ['#e8ecf3', '#9aa6b8'],
  },
  {
    id: 'tbill',
    symbol: 'TBILL',
    name: 'Short-dated treasuries',
    category: 'Treasury',
    decimals: 18,
    tint: ['#9fd8c4', '#3f8f78'],
  },
  {
    id: 'credit',
    symbol: 'CREDIT',
    name: 'Private credit note',
    category: 'Credit',
    decimals: 18,
    tint: ['#c9b6f0', '#7b5fc4'],
  },
  {
    id: 'estate',
    symbol: 'ESTATE',
    name: 'Real estate fund',
    category: 'Real estate',
    decimals: 18,
    tint: ['#f2b49e', '#d9705a'],
  },
  // Test assets named after real tokens, on each token's own code: none is the
  // issuer's deployment.
  {
    id: 'dmf',
    symbol: 'DMF',
    name: 'ERC-3643 test asset',
    category: 'Security',
    decimals: 18,
    tint: ['#b8d4f5', '#4f7fc4'],
  },
  {
    id: 'gro',
    symbol: 'GRO',
    name: 'ERC-3643 test asset',
    category: 'Security',
    decimals: 18,
    tint: ['#c4ecd9', '#4fae84'],
  },
  {
    id: 'tslax',
    symbol: 'TSLAX',
    name: 'eToro EToken test asset',
    category: 'Equity',
    decimals: 18,
    tint: ['#f5b8b8', '#c44f4f'],
  },
  {
    id: 'babax',
    symbol: 'BABAX',
    name: 'eToro EToken test asset',
    category: 'Equity',
    decimals: 18,
    tint: ['#f5d6b8', '#d98a3f'],
  },
  {
    id: 'buidl',
    symbol: 'BUIDL',
    name: 'Securitize DS test asset',
    category: 'Treasury',
    decimals: 6,
    tint: ['#d0d4dc', '#4a5060'],
  },
  {
    id: 'vbill',
    symbol: 'VBILL',
    name: 'Securitize DS test asset',
    category: 'Treasury',
    decimals: 6,
    tint: ['#b8e6f5', '#2f8fb0'],
  },
];

function resolve(meta: AssetMeta): Asset {
  const configured = (deployment.assets ?? {})[meta.id] ?? {};

  // Legacy single-asset deployments predate the catalogue: adopt their token as
  // the first entry so an existing deployment keeps working.
  const legacy: AssetAddresses =
    !deployment.assets && meta.id === CATALOGUE[0].id
      ? { evm: deployment.evm, starknet: deployment.starknet }
      : {};

  const addresses: AssetAddresses = {
    evm: configured.evm ?? legacy.evm,
    starknet: configured.starknet ?? legacy.starknet,
  };

  const available = Boolean(
    addresses.evm?.lockbox &&
    addresses.evm?.token &&
    addresses.starknet?.token &&
    addresses.starknet?.gateway &&
    addresses.starknet?.registry
  );

  // A pool is shared across assets, so a deployment-level main pool counts even
  // when this asset's gateway has none recorded of its own.
  const pool = addresses.starknet?.pool ?? deployment.veil?.pool;

  return { ...meta, addresses, available, poolReady: Boolean(pool) };
}

export const assets: Asset[] = CATALOGUE.map(resolve);

/// Faucet tokens on the source chain, for "Get faucets".
///
/// Keyed on the EVM token ALONE, deliberately -- not on `available`. Claiming
/// test tokens needs nothing but the token: the lockbox, the twin and the
/// gateway are irrelevant to it. Requiring the full set would hide the button
/// during exactly the window it exists for, between deploying the faucet assets
/// and wiring the Starknet side.
export const faucetTokens = (): string[] =>
  assets.filter((a) => a.addresses.evm?.token)
        .map((a) => a.addresses.evm!.faucet ?? a.addresses.evm!.token!);

export const faucetRouter = (): string | undefined => deployment.faucet?.router;

export const availableAssets = (): Asset[] => assets.filter((a) => a.available);

export function assetById(id: string): Asset {
  const found = assets.find((a) => a.id === id);
  if (!found) throw new Error(`unknown asset "${id}"`);
  return found;
}

/// What the card should open on: the first deployed asset, else the first in the
/// catalogue so the UI still renders something meaningful.
export function defaultAsset(): Asset {
  return availableAssets()[0] ?? assets[0];
}
