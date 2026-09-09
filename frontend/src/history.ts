// Local transfer log. Deliberately per-browser: a bridge transfer is already
// recorded on two chains and on LayerZero Scan, so this exists to give the user
// their own links back, not to be a source of truth.

import { deployment } from './config';

export type Direction = 'toStarknet' | 'toEvm';
export type Status = 'sent' | 'minted' | 'quarantined' | 'failed';

export type Transfer = {
  id: string;
  direction: Direction;
  /** Catalogue id, so a row still resolves after the selected asset changes. */
  asset?: string;
  symbol?: string;
  amount: string;
  recipient: string;
  hash: string;
  guid?: string;
  status: Status;
  at: number;
};

const KEY = `veil-bridge:${deployment.evmNetwork ?? 'unknown'}:${deployment.starknetNetwork ?? 'unknown'}`;

export function load(): Transfer[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Transfer[]) : [];
  } catch {
    // Private windows and blocked site data both throw here; an empty history
    // is a fine outcome, a crashed page is not.
    return [];
  }
}

function save(items: Transfer[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, 50)));
  } catch { /* nothing we can do, and nothing depends on it */ }
}

export function record(t: Omit<Transfer, 'id' | 'at'>): Transfer {
  const item: Transfer = { ...t, id: `${t.hash}:${Date.now()}`, at: Date.now() };
  save([item, ...load()]);
  return item;
}

export function update(id: string, status: Status): void {
  save(load().map((t) => (t.id === id ? { ...t, status } : t)));
}
