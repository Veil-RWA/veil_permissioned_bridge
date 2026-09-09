// The assets this bridge carries.
//
// One lockbox and one twin PER ASSET -- assets are never pooled, because a
// shared lockbox would let one issuer's pause or compromise reach another
// issuer's holders, and would blur the escrow invariant. So each entry here
// carries its own contract set, filled in by the deployment scripts.
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

export type AssetCategory = 'Metal' | 'Treasury' | 'Credit' | 'Real estate' | 'Equity';

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
  evm?: { lockbox?: string; token?: string; complianceReader?: string };
  starknet?: { token?: string; gateway?: string; registry?: string; compliance?: string };
};

export type Asset = AssetMeta & {
  addresses: AssetAddresses;
  /** Every contract this asset needs is deployed and wired. */
  available: boolean;
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

  return { ...meta, addresses, available };
}

export const assets: Asset[] = CATALOGUE.map(resolve);

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
