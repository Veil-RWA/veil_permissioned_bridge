// What the eligibility card CLAIMS must match what the contracts DO.
//
// Build first (test.sh does this):
//   npx esbuild src/eligibility.ts --bundle --format=esm --platform=node \
//     --outfile=src/eligibility.bundle.mjs --define:import.meta.env='{}'
//
// The case that matters is the first bridge-in. `handle_mint` applies the
// sender's snapshot, binds the recipient wallet, and only then checks
// `can_bridge_mint` -- so a recipient the mirror has never seen arrives
// ELIGIBLE. An empty mirror is not a refusal, and saying "will arrive held"
// there tells a registered holder the opposite of what will happen.

import { recipientGate } from './eligibility.bundle.mjs';

let pass = 0;
const fail = [];

function ok(name, cond) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail.push(name); console.log('  FAIL  ' + name); }
}

const LABEL = 'Starknet Sepolia';

/// A mirror that answered, with the given binding.
const mirror = (over = {}) => ({
  readable: true,
  identity: 0n,
  identityKnown: true,
  verified: false,
  balance: 0n,
  pending: 0n,
  fresh: false,
  freshnessKnown: false,
  syncedAt: 0,
  stalenessWindow: 86400,
  ...over,
});

const source = (over = {}) => ({
  balance: 0n,
  allowance: 0n,
  verified: true,
  frozen: false,
  paused: false,
  lockboxRegistered: true,
  country: 840,
  ...over,
});

const SENDER = '0x878ffCF3351C6596Bd75355E00319AB5Fcf1c639';

// ── the bug this file exists for ────────────────────────────────────────────

{
  // Unbound recipient + verified sender = the ordinary first bridge-in.
  const g = recipientGate(mirror({ identity: 0n }), source(), SENDER, LABEL);
  ok('a first bridge-in with a verified sender is CLEARED, not held', g.ok === true);
  ok('and it says the snapshot travels with the transfer',
    /travels|carries/i.test(g.detail ?? ''));
  ok('it never claims the transfer will be held',
    !/will be held|arrive held|not yet mirrored/i.test(g.detail ?? ''));
}

{
  // Same empty mirror, but the sender is not verified upstream: gate 1 is the
  // one that fails, and this gate must agree rather than contradict it.
  const g = recipientGate(mirror({ identity: 0n }), source({ verified: false }), SENDER, LABEL);
  ok('an unbound recipient with an unverified sender is not cleared', g.ok === false);
}

// ── the case that genuinely lands held ──────────────────────────────────────

{
  const other = BigInt('0x1111111111111111111111111111111111111111');
  const g = recipientGate(mirror({ identity: other, verified: true }), source(), SENDER, LABEL);
  ok('a wallet bound to a DIFFERENT source identity is refused', g.ok === false);
  ok('and it names the binding conflict, not a missing record',
    /already bound to a different/i.test(g.detail ?? ''));
}

// ── the ordinary repeat bridger ─────────────────────────────────────────────

{
  const mine = BigInt(SENDER);
  const g = recipientGate(mirror({ identity: mine, verified: true }), source(), SENDER, LABEL);
  ok('a wallet already bound to this sender uses the mirror verdict', g.ok === true);
}

{
  const mine = BigInt(SENDER);
  const g = recipientGate(
    mirror({ identity: mine, verified: false, freshnessKnown: true, fresh: false }),
    source(), SENDER, LABEL,
  );
  ok('a stale record for this sender still fails closed', g.ok === false);
  ok('and says so', /stale/i.test(g.detail ?? ''));
}

// ── unknown is its own state ────────────────────────────────────────────────

{
  const g = recipientGate(mirror({ readable: false }), source(), SENDER, LABEL);
  ok('an unreadable mirror is UNKNOWN, never a refusal', g.ok === null);
  ok('and says it is not a refusal', /not a refusal/i.test(g.detail ?? ''));
}

{
  const g = recipientGate(undefined, source(), SENDER, LABEL);
  ok('no mirror read yet is unknown', g.ok === null);
}

{
  const g = recipientGate(mirror({ readable: false }), source(), SENDER, LABEL, true);
  ok('the demo deployment says the registry is not on chain', /Demo deployment/.test(g.detail ?? ''));
}

// ── a sender address that will not parse must not crash the card ────────────

{
  const other = BigInt('0x2222222222222222222222222222222222222222');
  const g = recipientGate(mirror({ identity: other, verified: true }), source(), 'not-an-address', LABEL);
  ok('an unparseable sender falls back to the mirror verdict', g.ok === true);
}

console.log('');
if (fail.length) {
  console.log(fail.length + ' failed, ' + pass + ' passed');
  process.exit(1);
}
console.log(pass + ' passed');
