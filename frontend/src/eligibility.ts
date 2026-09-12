// Eligibility gate logic, kept out of main.ts so it can be tested without a
// DOM or a wallet. These functions decide what the card SAYS about a transfer,
// which is a claim about what the contracts will do -- so they are pinned by
// src/eligibility.test.mjs against the behaviour of `handle_mint`.

import type { MirrorStatus } from './starknet';
import type { EvmStatus } from './evm';

export type Gate = { ok: boolean | null; label: string; detail?: string };

/// Why the mirror could not be asked. Returned only when it did not answer, so
/// the gate renders unknown -- an unread registry says nothing about a holder,
/// and saying otherwise accuses a registered one of not being registered.
export function mirrorUnreadable(isDemo: boolean): string {
  return isDemo
    ? 'Demo deployment: the mirrored registry is not on chain, so eligibility cannot be checked here.'
    : 'The mirrored registry did not answer, so this could not be checked. It is not a refusal.';
}

/// Why the mirror says no. Only reached once it HAS answered.
export function mirrorRefusal(m: MirrorStatus, self: boolean): string {
  if (!m.identityKnown) return 'The mirror does not list this wallet as eligible.';
  if (m.identity === 0n) {
    return 'This wallet is not bound to any source identity, so it cannot hold or move the twin.';
  }
  if (!m.freshnessKnown || m.fresh) return 'The mirror says this identity is not currently eligible.';
  return self
    ? 'The mirrored record has gone stale. Anyone can refresh it with syncCompliance.'
    : 'The mirrored record has gone stale, so it fails closed until refreshed.';
}

/// What the mirror says about the RECIPIENT of a bridge-in -- which is not the
/// same question as what it says about a holder already on this chain.
///
/// A MINT carries the sender's eligibility snapshot with it, under a fresh
/// `seq` (the lockbox bumps it on every bridge-out). `handle_mint` applies that
/// record -- rewriting `verified`, `frozen` and `synced_at` -- binds the
/// recipient wallet to the sender's EVM account, and only THEN checks
/// `can_bridge_mint`. So when the recipient is unbound, or already bound to
/// this sender, whatever the mirror holds right now (nothing, a stale record,
/// an old revocation) is overwritten before the check. What decides it is the
/// SENDER's record on the source registry. Reading the mirror's current record
/// as "will arrive held" tells a registered holder they are not registered.
///
/// What the snapshot does NOT overwrite:
///   - a binding to a DIFFERENT EVM account: inbound messages never re-point a
///     binding, so the mint quarantines with BINDING_CONFLICT;
///   - the mirror's global pause, which only `syncGlobal` moves.
export function recipientGate(
  m: MirrorStatus | undefined,
  source: EvmStatus | undefined,
  sender: string | undefined,
  starknetLabel: string,
  isDemo = false,
): Gate {
  const label = `Recipient is eligible on ${starknetLabel}`;
  if (!m) return { ok: null, label };
  if (!m.readable) return { ok: null, label, detail: mirrorUnreadable(isDemo) };

  let senderId: bigint | undefined;
  if (sender !== undefined) {
    try { senderId = BigInt(sender); } catch { senderId = undefined; }
  }

  if (m.identityKnown && m.identity !== 0n && senderId !== undefined && senderId !== m.identity) {
    return {
      ok: false,
      label,
      detail: 'This wallet is already bound to a different source identity. A message never re-points a binding, so the transfer will be held and released with claim_to_note.',
    };
  }

  const snapshotDecides = m.identityKnown && (m.identity === 0n || m.identity === senderId);
  if (!snapshotDecides) {
    return { ok: m.verified, label, detail: m.verified ? undefined : mirrorRefusal(m, false) };
  }

  // The source gates already explain a refusal there; this one just agrees.
  if (!source) return { ok: null, label };
  if (!source.verified || source.frozen) return { ok: false, label };

  // `is_verified` folds in the pause, so a true answer rules it out. A false
  // one could be the pause or a record the snapshot is about to replace.
  if (m.globalPaused === true) {
    return {
      ok: false,
      label,
      detail: 'Transfers are paused on the mirror, so the transfer will be held until the pause is lifted.',
    };
  }
  if (!m.verified && m.globalPaused === undefined) {
    return {
      ok: null,
      label,
      detail: 'The mirror pause flag did not answer, so this could not be checked. It is not a refusal.',
    };
  }

  return {
    ok: true,
    label,
    detail: m.identity === 0n
      ? 'First bridge-in. The transfer carries your eligibility snapshot, so the mirror is written before the mint is checked.'
      : undefined,
  };
}
