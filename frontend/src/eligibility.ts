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
/// A MINT carries the sender's eligibility snapshot with it. `handle_mint`
/// applies that record, binds the recipient wallet to the sender's EVM account,
/// and only THEN checks `can_bridge_mint`. So a recipient the mirror has never
/// seen is the ordinary first-bridge case and arrives eligible -- what decides
/// it is the SENDER's record on the source registry, which is its own gate.
/// Reading an empty mirror as "will arrive held" states the opposite of what
/// the contract does, and tells a registered holder they are not registered.
///
/// The one case that genuinely lands held is a wallet already bound to a
/// DIFFERENT EVM account: inbound messages never re-point a binding, so the
/// mint quarantines with BINDING_CONFLICT.
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

  if (m.identityKnown && m.identity === 0n) {
    // Unbound: eligibility travels with the transfer, so this gate restates the
    // source registry's answer about the sender rather than the mirror's
    // silence about the recipient.
    return {
      ok: source ? source.verified : null,
      label,
      detail: source && source.verified
        ? 'First bridge-in. The transfer carries your eligibility snapshot, so the mirror is written before the mint is checked.'
        : undefined,
    };
  }

  if (m.identityKnown && m.identity !== 0n && sender !== undefined) {
    let senderId: bigint | undefined;
    try { senderId = BigInt(sender); } catch { senderId = undefined; }
    if (senderId !== undefined && senderId !== m.identity) {
      return {
        ok: false,
        label,
        detail: 'This wallet is already bound to a different source identity. A message never re-points a binding, so the transfer will be held and released with claim_to_note.',
      };
    }
  }

  return { ok: m.verified, label, detail: m.verified ? undefined : mirrorRefusal(m, false) };
}
