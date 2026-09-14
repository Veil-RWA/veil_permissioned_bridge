# For issuers — allow an ERC-3643 asset onto Veil Bridge

Veil Bridge lets holders of your permissioned ERC-3643 token **escrow on
Ethereum** and settle privately inside Veil, with your compliance state carried
across. Holders do not need to understand the settlement network under Veil;
neither do you, day to day.

This page is the operator checklist. The protocol README
([README.md](README.md)) covers contracts and threat model.

## What you are consenting to

T-REX verifies the *recipient* of every transfer. On a bridge-out the recipient
is the **lockbox**. Registering that lockbox as a verified identity in your
token's identity registry is the live switch that allows escrow. De-registering
it withdraws consent. Nothing else grants the bridge the right to hold your
asset.

## Checklist (production)

Do these once per asset. Each asset gets its own lockbox and twin — escrow is
never shared across issuers.

### 1. Deploy / wire the bridge for your token

Operators run the scripts in `scripts/` (see [scripts/README.md](scripts/README.md)).
You need the resulting **lockbox address** for your token.

### 2. Register the lockbox (your KYC decision)

On your EVM identity registry, register the lockbox as a verified identity —
the same way you register any approved holder. Until this lands, every escrow
reverts *inside your token*, and the app surfaces **"Bridge not approved by
issuer"**.

### 3. Export your compliance rules (EVM read)

From a machine that can reach your RPC:

```bash
cd tools
node export-compliance.js --rpc $RPC --token 0x<your-erc3643> --out spec.json
```

Read `spec.json` (and the report). The exporter names any T-REX modules it
cannot mirror (time-window and fee modules, etc.). Decide with that list in
front of you — the twin will not invent enforcement for what it cannot replay.

### 4. Apply the rules on the twin (operator commit)

```bash
node apply-compliance.js --spec spec.json --compliance 0x<MirroredCompliance>
```

This prints a ready-to-run invoke. Nothing is sent automatically: committing
your rules should be a command you read first. After it lands, call
`export_spec` on the same contract and diff against the file.

### 5. Sync global + holder eligibility

- `syncGlobal` — token pause / global state
- `syncCompliance(holder)` — permissionless refresh of one holder's mirror

Records expire after `staleness_window` seconds and fail closed until refreshed.
Quote that window to compliance and ops.

### 6. Confirm the Veil pool can hold the twin

The default delivery is a **Veil pool note** (private settlement), not a public
wallet balance. The pool must be a registered holder of the twin for fills to
succeed. If it is not, the app will say the pool cannot be used until you
register it.

## What holders see

1. Connect their **Ethereum** wallet (source of the ERC-3643 balance).
2. Connect their **Veil** wallet (settlement / private note).
3. Pass eligibility (verified, not frozen, token not paused, lockbox approved).
4. Press **Bridge** — viewing key, note, claim, and allowance run inside that
   one press when missing.

If a transfer arrives while the recipient is not eligible, value is **held and
claimable**, never rejected into the void.

## Language for internal docs

Prefer:

| Prefer | Avoid leading with |
|---|---|
| Escrow on Ethereum | Mint on Starknet |
| Settle privately in Veil | Public twin balance |
| Compliance mirror / eligibility sync | Layer-2 jargon in issuer decks |
| Lockbox registration | "Bridge wallet" |

Starknet and LayerZero remain how the bridge is built; they are not what an
issuer needs to operate day to day beyond quoting the staleness window and
keeping the lockbox registered.

## Support triage (common blocks)

| Symptom in the app | Likely cause | Who acts |
|---|---|---|
| Bridge not approved by issuer | Lockbox not in identity registry | Issuer agent |
| Not eligible to bridge | Holder not verified / frozen / paused | Issuer KYC / token admin |
| Pool cannot be used | Pool not registered for this twin | Issuer / bridge operator |
| Mirrored record stale | Past `staleness_window` | Anyone — `syncCompliance` |
| Note creation unavailable | Prover endpoint not configured | Bridge operator |

## See also

- Compliance export/apply: [README.md § Replicating an EVM token's compliance rules](README.md#replicating-an-evm-tokens-compliance-rules)
- Testnet runbook: [scripts/README.md](scripts/README.md)
- App: `frontend/` — Transfer card + **Issuer** tab (same checklist, in-app)
