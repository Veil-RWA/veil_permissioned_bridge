// Where a LayerZero message is, in words a holder can act on.
//
// Every bridge message -- an eligibility update, issuer rules, a bridge-in --
// crosses through LayerZero, and while it is on its way nothing on either chain
// says so. LayerZero Scan does: its public API answers browsers directly
// (`access-control-allow-origin: *`), keyed by the source transaction hash. The
// app asks it rather than making the holder guess why nothing has arrived.

import { LZ_API } from './config';

export type LzStage = 'confirming' | 'verifying' | 'delivering' | 'delivered' | 'failed' | 'unknown';

export type LzStatus = {
  stage: LzStage;
  /// One line for the holder.
  text: string;
  /// LayerZero's own status message, kept for support.
  raw?: string;
  /// When LayerZero first saw the message (ms).
  since?: number;
  dstTx?: string;
};

type ScanMessage = {
  created?: string;
  status?: { name?: string; message?: string };
  verification?: { dvn?: { status?: string } };
  destination?: { status?: string; tx?: { txHash?: string } };
};

/// The message sent by `txHash`, or undefined while LayerZero has not indexed
/// it (the first seconds after the source transaction) or cannot be reached.
export async function lzStatus(txHash: string): Promise<LzStatus | undefined> {
  try {
    const res = await fetch(`${LZ_API}/v1/messages/tx/${txHash}`);
    if (res.status === 404) return { stage: 'confirming', text: 'Waiting for LayerZero to pick it up' };
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: ScanMessage[] };
    const m = body.data?.[0];
    if (!m) return { stage: 'confirming', text: 'Waiting for LayerZero to pick it up' };
    return describe(m);
  } catch {
    return undefined;
  }
}

export function describe(m: ScanMessage): LzStatus {
  const name = (m.status?.name ?? '').toUpperCase();
  const raw = m.status?.message;
  const since = m.created ? Date.parse(m.created) : undefined;
  const dstTx = m.destination?.tx?.txHash;
  if (name === 'DELIVERED') return { stage: 'delivered', text: 'Delivered', raw, since, dstTx };
  if (name === 'FAILED' || name === 'BLOCKED' || name === 'PAYLOAD_STORED') {
    return { stage: 'failed', text: 'LayerZero could not deliver it', raw, since, dstTx };
  }
  if (name === 'CONFIRMING') {
    return { stage: 'confirming', text: 'Waiting for Ethereum confirmations', raw, since };
  }
  if (name === 'INFLIGHT') {
    return m.verification?.dvn?.status === 'SUCCEEDED'
      ? { stage: 'delivering', text: "Verified — waiting for LayerZero's executor to deliver it", raw, since }
      : { stage: 'verifying', text: 'Waiting for LayerZero to verify it', raw, since };
  }
  return { stage: 'unknown', text: raw ?? (name || 'Status unknown'), raw, since, dstTx };
}

/// "for 12 min" from `since`.
export function elapsed(since: number | undefined, now = Date.now()): string {
  if (since === undefined || Number.isNaN(since)) return '';
  const min = Math.max(0, Math.round((now - since) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `for ${min} min`;
  const h = Math.floor(min / 60);
  return `for ${h} h ${min % 60} min`;
}

type WalletMessage = ScanMessage & {
  pathway?: { sender?: { address?: string } };
  source?: { tx?: { txHash?: string; payload?: string } };
};

export type WalletInFlight = { hash: string; sender: string; kind: number; status: LzStatus };

/// Messages `wallet` sent that LayerZero has not finished, with the OApp that
/// sent them (a lockbox) and the bridge message kind (the payload's first byte:
/// 1 a bridge-in, 2 an eligibility update, 5 and 6 issuer rules). Found on
/// LayerZero Scan rather than in this browser's History, so a message sent from
/// another device, or before a reload, is still seen -- and not paid for twice.
export async function inFlightByWallet(wallet: string): Promise<WalletInFlight[]> {
  try {
    const res = await fetch(`${LZ_API}/v1/messages/wallet/${wallet}?limit=25`);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: WalletMessage[] };
    const out: WalletInFlight[] = [];
    for (const m of body.data ?? []) {
      const hash = m.source?.tx?.txHash;
      const sender = (m.pathway?.sender?.address ?? '').toLowerCase();
      if (!hash || !sender) continue;
      const status = describe(m);
      if (status.stage === 'delivered' || status.stage === 'failed') continue;
      out.push({ hash, sender, kind: parseInt((m.source?.tx?.payload ?? '').slice(2, 4), 16), status });
    }
    return out;
  } catch {
    return [];
  }
}
