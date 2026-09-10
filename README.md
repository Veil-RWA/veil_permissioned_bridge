# Veil bridge — permissioned ERC-3643 across LayerZero

Locks a permissioned ERC-3643 asset in a lockbox on an EVM chain and mints a
permissioned twin on Starknet, carrying the source chain's **compliance state**
across with the tokens. Burn on Starknet to release the escrow.

This is the OFT-adapter pattern with the part that pattern leaves out. A bearer
token can be wrapped by anyone, because there is nothing to carry across. A
permissioned one cannot: the twin is only as legitimate as its eligibility data,
so the eligibility data has to travel, keep travelling, and expire when it stops.

Self-contained: it shares no code with the `veil` pool package in either
direction. The twin plugs into a Veil ERC-3643 pool by exposing the same
entrypoint *names* (`transfer`, `identity_registry`, `is_verified`, …), not by
linking against it.

```
bridge/
  cairo/          Starknet side — own Scarb package (veil_bridge)
    src/          mirrored_registry, bridged_token, gateway, compliance/rules
    tests/        113 tests (incl. 26 attack, 14 pool delivery, 12 pool choice)
  evm/            EVM side — own solc build + harness
    contracts/    VeilERC3643Lockbox, ComplianceReader, BridgeMsgCodec, lz/
    test/         44 tests (incl. 15 attack tests) + a JSON-RPC test node
  tools/          export/apply the compliance rule set — 7 unit + 11 integration
  scripts/        testnet deployment: deploy, wire, bridge one for real
  frontend/       the bridge app (Vite + TypeScript), vendoring the Veil SDK
```

## Contracts

| Contract | Chain | Role |
|---|---|---|
| `VeilERC3643Lockbox` | EVM | escrow, compliance snapshot + push, release |
| `ComplianceReader` | EVM | read-only introspection of a live T-REX deployment |
| `OAppLite` + `lz/` | EVM | vendored LayerZero V2 surface |
| `VeilMirroredRegistry` | Starknet | replayed eligibility; drop-in T-REX registry |
| `VeilBridgedERC3643` | Starknet | the permissioned twin |
| `MirroredCompliance` | Starknet | the EVM token's rule set, restated |
| `VeilBridgeGateway` | Starknet | LayerZero OApp: receive, mint, burn, send |

## Replicating an EVM token's compliance rules

This is the part you drive when you allow an asset onto the bridge. Two
commands:

```bash
cd bridge/tools
node export-compliance.js --rpc $RPC --token 0x<erc3643> --out spec.json
node apply-compliance.js  --spec spec.json --compliance 0x<starknet MirroredCompliance>
```

The first reads the live token and writes a `ComplianceSpec`. The second prints
a ready-to-run `sncast invoke` for `apply_spec`, plus the `export_spec` call to
verify it landed. Nothing is sent automatically — committing an issuer's rules
should be a command you read first.

**Why exporting is not a simple read.** T-REX modules expose per-item getters
and no enumeration, and `MaxBalanceModule` exposes *nothing* — its cap is
`private` and appears only in the `MaxBalanceSet` event. Neither source alone
works: events show history including entries since removed, and getters cannot
tell you what to ask about. So the tool learns **candidates from event logs**
and confirms which are **still in force via live getters**. The result matches
the chain, not its history. The max balance is the one field that cannot be
confirmed, and the exporter flags it as event-derived every time.

`apply_spec` **replaces** the rule set rather than merging, so re-running with a
narrower spec clears what the previous one set. `export_spec` returns the same
shape, so a deployment can be diffed against the file that produced it instead
of trusted.

### What is mirrored

| T-REX module | Mirrored | Semantics reproduced |
|---|---|---|
| `CountryAllowModule` | yes | receiver's country only |
| `CountryRestrictModule` | yes | receiver's country only |
| `MaxBalanceModule` | yes | `value <= max` **and** per-**identity** balance + value <= max |
| `SupplyLimitModule` | yes | mints only (`from == 0`) |
| `TransferRestrictModule` | yes | mint/burn exempt; otherwise `allowed(from) OR allowed(to)` |
| `TimeTransfersLimitsModule` | **no** | rolling time windows; counters are source-chain state |
| `TimeExchangeLimitsModule` | **no** | same |
| `ExchangeMonthlyLimitsModule` | **no** | same |
| `ConditionalTransferModule` | **no** | per-transfer approvals granted on the source chain |
| `TransferFeesModule` | **no** | fees are collected on the source chain |
| `TokenListingRestrictionsModule` | **no** | governs source-chain listing, not holder eligibility |

The unmirrored six are stateful per-transfer rules whose accounting cannot be
reconstructed from a snapshot; a "mirror" of one would be a guess. The exporter
names any it finds and says the twin will not enforce them — decide with that in
front of you. For anything custom, `add_rule` takes an ordinary
`IComplianceRule` contract alongside the built-ins.

Two deliberate divergences, both forced by the chain boundary and both in the
safe direction:

- **Identities are EVM accounts.** T-REX keys MaxBalance and TransferRestrict on
  an ONCHAINID address. Here the handle is the EVM account the mirror already
  keys eligibility on, resolved through the wallet binding. This is what makes
  per-identity balance correct when one investor holds two Starknet wallets —
  they share one allowance, as they would share one ONCHAINID upstream. A
  per-address port gets this wrong, and bridging creates second wallets
  routinely, so `max_balance_counts_per_identity_not_per_wallet` pins it.
- **An unbound wallet has no identity**, so every identity-keyed rule fails
  closed for it.

## Where a bridge-in lands

**Always a Veil pool note.** There is no wallet delivery and no wallet fallback.
The twin is a permissioned asset whose point is to settle privately inside the
pool, so a public balance on Starknet is the thing this bridge exists to avoid.
The note id and the pool ride in the MINT message.

A transfer that cannot be filled — no note, unclaimed, pool paused or refusing —
is **quarantined** on the gateway: held, not minted anywhere, and released later
with `claim_to_note` into a note the recipient has claimed. That is the only way
value leaves quarantine. Nothing anywhere mints the twin to a holder's wallet.

A holder who wants a public balance withdraws it from the pool, which is the
pool's own unshield and not something the bridge does.

### Which pool

A Veil pool is **multi-asset**: one pool carries any number of ERC-3643 tokens
(`allowed_tokens` on `VeilERC3643`). So the asset never implies the pool, and
something has to choose.

- **By default, the main Veil pool** — already deployed, already carrying
  assets. This is the gateway's configured default (`set_pool`), and it is what
  a message that names no pool gets. Naming nothing is the common case.
- **Optionally, another pool.** Veil allows an entity that wants its own
  separate pool to deploy one through `VeilERC3643Factory.create_pool`. A sender
  can address a transfer to one by naming its address.

Naming a pool means an address arrives over the wire and the gateway is asked to
call it from inside `lz_receive`. It does not do that on a peer's say-so.
`create_pool` is the only way a Veil pool exists and it records the deployer in
`pool_owner`, so the gateway asks the factory (`set_factory`) first: a non-zero
owner is proof of a genuine pool. A pool that does not check out is declined and
the amount lands in the wallet. This keeps the choice permissionless — a pool
created a minute ago works, with no operator-maintained allowlist — without
letting a message point the gateway at a contract of its own choosing.

The app checks the same thing **before** the source chain is touched, so a typo
costs nothing rather than costing a message. It checks two things, because both
have to be true: that the factory made the pool, and that the pool actually
carries this asset (`is_token_allowed`) — multi-asset is not every-asset.

The gateway calls the pool's `fill_open_note` directly. Two things must be in
place, both on the pool's side: the gateway must be on its `allowed_adapters`
list, and the pool must be a registered holder of the twin (`--holder` above).
Missing either, the fill is declined and the amount lands in the wallet.

**The note must be claimed first.** `fill_open_note` is one-shot and the pool
cannot say who owns a note, while note ids are public. Without a claim, any
sender could name any note and burn it with dust so its real proceeds could
never arrive. So the holder claims the note on the gateway, and only a transfer
addressed to that same holder may fill it. Claims are write-once.

**Delivery is best-effort, and that is a safety property.** By the time a MINT
arrives the tokens are already escrowed on the source chain, so `lz_receive` may
not reject it. The gateway therefore mints into its own custody and lets the
pool **pull**, rather than pushing tokens at it. A pool that reverts, is paused,
has not allow-listed the gateway, or takes nothing never receives anything —
whatever is left in the gateway's custody is **burned back** and the amount is
held as pending, so `total_supply + total_pending` still equals the escrow and
no public balance is ever created. An amount at or above 2^128 cannot fit a note
and is refused on the source chain, where it is free.

`claim_to_note` is the one place that may revert, and deliberately: nothing has
been spent to reach it, so failing loudly and leaving the amount pending is safe
and retryable. Everything on the `lz_receive` path quarantines instead.

## The three problems a naive mirror gets wrong

**Address gap.** The EVM registry judges an EVM address; the holder on Starknet
is a different address. Records key on the **EVM account** — the subject of
compliance — with a separate binding per Starknet wallet. One identity can back
several wallets, and revoking it revokes all of them in one write. A bound
wallet can never be re-pointed by an inbound message; only `admin_rebind` moves
it, the same recovery power T-REX grants agents.

**Staleness.** A mirror only knows what was last pushed. Records expire: past
`staleness_window` seconds `is_verified` returns **false** and the asset stops
moving. Refresh is permissionless — `syncCompliance` forwards only what the live
registry already says, so a caller cannot assert anything of their own. That
window is the number to quote an issuer.

**Ordering.** LayerZero is unordered by default, so a stale "verified" can land
after a fresh "revoked". Every record carries a source-assigned monotonic `seq`;
updates with `seq <= stored` are dropped. Replay is the endpoint's job — it runs
each `(srcEid, sender, nonce)` at most once.

## Never revert on a policy outcome

By the time a mint arrives the tokens are already escrowed on the source chain.
A reverting `lz_receive` strands them behind a retryable message. So an
ineligible recipient is **quarantined** in the gateway's `pending` (claimable
later), and an ineligible release is **held** in the lockbox's `claimable`. Both
are permissionless to release and can only pay the party the original message
named. Protocol errors — unknown kind, truncated payload, dirty address word —
*do* revert, because those are bugs and a stuck message is how you find one.

## Wire format

Packed big-endian, no padding. Defined in `cairo/src/msg_codec.cairo`, mirrored
in `evm/contracts/BridgeMsgCodec.sol`. Both test suites pin the same vectors, so
a one-sided change fails a test rather than a testnet.

| Kind | Direction | Bytes | Payload |
|---|---|---|---|
| 1 `MINT` | EVM → SN | 142 | evm_sender, sn_recipient, amount, seq, verified, frozen, country, delivery, note_id |
| 2 `IDENTITY` | EVM → SN | 45 | evm_account, seq, verified, frozen, country |
| 3 `GLOBAL` | EVM → SN | 10 | seq, paused |
| 4 `UNLOCK` | SN → EVM | 65 | evm_recipient, amount |

`GLOBAL` carries token **state** only. Rule **parameters** are replicated once
at allowance time into `MirroredCompliance`, so each rule has exactly one home.

## Deployment

**Precondition, and it is the whole authorisation model.** T-REX verifies the
*recipient* of every transfer, and on a bridge-out the lockbox is the recipient.
The issuer must register the lockbox as a verified identity in the token's
registry or nothing can be escrowed. This bridge therefore cannot be pointed at
an unwilling issuer's asset, and their consent stays a live on-chain switch they
can withdraw by de-registering the lockbox. That is the intended shape.

Endpoints (LayerZero metadata API, verified 2026-09):

| Network | eid | Endpoint |
|---|---|---|
| Ethereum mainnet | 30101 | `0x1a44076050125825900e736c501f859c50fe728c` |
| Ethereum Sepolia | 40161 | `0x6edce65403992e310a62460808c4b910d972f10f` |
| Starknet mainnet | 30500 | `0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68` |
| Starknet Sepolia | 40500 | `0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878` |

1. Starknet: deploy `VeilMirroredRegistry(owner, staleness_window)`.
2. Deploy `VeilBridgeGateway(owner, endpoint, STRK, registry, evm_eid)`.
3. Deploy `MirroredCompliance(owner, registry)`.
4. Deploy `VeilBridgedERC3643(name, symbol, owner, registry, compliance)`.
5. Wire: `registry.set_gateway`, `token.set_gateway`, `token.set_compliance`,
   `compliance.set_token`, `gateway.set_token`.
6. EVM: deploy `VeilERC3643Lockbox(endpoint, owner, token, starknet_eid)`.
7. `setPeer` on both sides, `setDelegate`, configure the DVN stack.
8. Issuer registers the lockbox in the source identity registry.
9. Replicate the rules (two commands above), then `syncGlobal` and
   `syncCompliance` per holder.

`staleness_window = 0` disables expiry — devnet only; on a live deployment it
means an unbounded revocation lag.

One lockbox and one twin per asset. The **escrow** is never shared: a shared
lockbox would let one issuer's pause or compromise reach another's holders, and
would blur the escrow invariant that `total_supply + total_pending` on Starknet
equals what is escrowed on EVM.

The Veil **pool** on the far side is the opposite, and this is not a
contradiction: one pool carries many assets without mixing their books, so every
asset here lands in the same main pool by default. Separate escrow, shared
pool.

## Toolchain note

The Starknet contracts implement LayerZero's `ILayerZeroReceiver` ABI and call
the endpoint through a locally declared `IEndpointV2`, rather than depending on
`@layerzerolabs/protocol-starknet-v2`. Structs, field order and function names
are copied from that package (read at v1.2.33), so serialization and selectors
match and the deployed endpoint drives these contracts unmodified — verified
against the generated ABI.

The reason is version skew: the package pins `starknet = "2.14.0"`, the OZ
umbrella crate `2.0.0` and `snforge_std = "0.49.0"`, while this package is on
2.17.0, the split OZ crates and snforge 0.58.1 — and LayerZero's own docs warn
that mismatched versions produce class-hash mismatch errors.

To swap back once versions line up: add the `layerzero` package, replace the
inlined endpoint/peer assertions in `gateway.cairo` with `OAppCoreComponent` +
`OAppHooks::_lz_receive`, and drop `lz.cairo`/`bytes.cairo` in favour of
`layerzero::common::structs::*` and `lz_utils::byte_array_ext`. The wire format
and every other contract are unaffected.

`cairo/Scarb.lock` is seeded from the root `veil` package's lock: the registry
now carries an `openzeppelin_utils` requiring Cairo ^2.18, which a fresh resolve
would pick and then refuse to build on 2.17.

## Threat model

**Assumed honest:** the owner (who wires contracts and applies rule specs), the
issuer's agents, the configured LayerZero peer, and the DVN set backing the
pathway. A compromised peer can mint arbitrary twin supply or order arbitrary
releases — inherent to any bridge, and the reason the DVN configuration is part
of the security argument rather than an afterthought.

**Assumed hostile:** everyone else — any caller, any holder, any party who can
get a message delivered, any holder revoked on the source chain, and the token
itself, which the issuer chooses and the lockbox cannot vet.

**Invariant:** twin supply plus quarantined balance never exceeds what is
escrowed, and no address holds or moves twin tokens without a live, fresh,
un-revoked eligibility record.

**Known griefing vector, tested and bounded.** Anyone may bridge dust to any
Starknet address. If that address is unbound, it binds to the *sender's* EVM
identity — so an attacker can attach a stranger's wallet to their own identity,
and that wallet then freezes when the attacker is revoked. It transfers no value
to the attacker and misdirects nothing (the victim's own bridge-in quarantines
rather than paying the attacker), and `admin_rebind` undoes it. Preventing it
outright would mean pre-registering every recipient, which breaks first-time
bridging entirely. See `binding_capture_is_griefing_only_and_the_owner_can_undo_it`.

## The Veil SDK

The app vendors it (`frontend/vendor/veil-sdk`, refreshed by `npm run sync-sdk`)
and needs it for one thing: **deriving the holder's open-note id**.

A note id is not a handle a user can type. It is

```
note_id     = H(NOTE_ID, channel_key, token, index)
channel_key = H(DERIVE_CHANNEL_KEY, owner, scalar(k), owner, pub(k))
```

where `k` is the holder's private viewing key, recovered from a wallet signature
over fixed typed data and never leaving the device. So the id is bound to the
holder by construction — nobody else can derive it, and only that key can spend
the note. The app derives it, walks the holder's slots for one that is still
fillable, and uses that.

The derivation crosses a language boundary — TypeScript in the SDK, Cairo in the
pool — so both sides are pinned against the same fixed vectors
(`cairo/tests/test_note_derivation.cairo`, `frontend/src/notes.test.mjs`). A
drift there would have the app naming a note the pool has never seen, every pool
delivery falling back to the wallet, and nothing erroring.

Wallet delivery uses none of it: that path is plain contract calls.

## The app

`frontend/` is a Vite + TypeScript app in the shape of a bridge UI: sticky
Transfer/History nav, one centred card, a vertical From → To stack, quote
details inline above the action button.

It carries **multiple assets** — gold, silver, treasuries, private credit and
real estate in the shipped catalogue (`frontend/src/assets.ts`). Picking one
switches the entire contract set, not just a ticker, because there is one
lockbox and one twin per asset and the escrow is never shared. (The Veil pool
they land in IS shared — one pool carries every asset.) Assets the current
deployment does not carry stay visible and greyed rather than hidden, so the
question "does this bridge support my instrument" always has an answer on
screen.

The other thing a permissioned bridge needs that a bearer one does not is the
**eligibility panel**. On an ERC-3643 asset a transfer can be perfectly funded and still be
refused, so the card shows the gates in the order they fail — you are verified,
you are not frozen, the token is not paused, the bridge is an approved holder,
the recipient is eligible on the far side — before any gas is spent. The
lockbox-registration check is the one people trip over, and it gets its own line
with the reason.

It also distinguishes *blocked* from *will arrive held*: a recipient the mirror
has never seen is a warning, not an error, because the transfer succeeds and
lands claimable.

```bash
cd frontend && npm run dev      # reads ../deployments/<pair>.json
```

With no deployment present it renders a "not deployed" state rather than failing
to build, so the UI can be worked on before anything is on chain.

## Toolchain

**starknet.js v10 or newer.** Live Sepolia serves RPC spec 0.10.x; v6 speaks 0.7
and cannot reach it. Its `Account` takes an options object, not positional
arguments. Wallet support is built in, so there is no `get-starknet` dependency.

Starknet RPC endpoints must serve spec 0.8+. Verify one with:

```bash
curl -s -X POST $STARKNET_RPC_URL -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"starknet_specVersion","params":[]}'
```

`starknet-devnet` cannot run these contracts: it rejects Sierra 1.8.0. Use a
Sepolia endpoint.

## Deploying

See [scripts/README.md](scripts/README.md) for the testnet runbook: deploy both
sides, wire the peers, have the issuer register the lockbox, replicate the
compliance rules, then `bridge.js` sends one transfer for real and polls the far
side until it lands.

## Running it

Toolchain versions are pinned in `.tool-versions` (scarb 2.17.0, starknet-foundry
0.58.1). They have to be: `snforge_std` and the `snforge` binary must match, and
an older binary fails every test with a `set_next_syscall_from_cheatcode is not
supported` hint error rather than anything that points at the cause.

```bash
bash setup.sh                       # npm install + link node_modules
bash test.sh                        # everything, 172 tests
(cd cairo && snforge test)          # 101
(cd evm/script && bash test.sh)     # 44
(cd tools && node spec.test.js)     # 7
(cd tools && node compliance-export.test.js)  # 11
(cd frontend && node src/notes.test.mjs)      # 9
```

**Behaviour:** wire-format vectors pinned from both chains; sequence ordering and
duplicate drops; staleness expiry, refresh, and its effect on transfers and
exits; revocation fanning out to every bound wallet; binding-conflict
quarantine; a snapshot overtaken by a revocation; quarantine and claim on both
sides; fee collection; the supply/escrow invariant across a round trip; the
exact semantics of all five mirrored T-REX modules including per-identity
balance; `apply_spec` replace-not-merge and `export_spec` round-trip.

**Attacks** (`cairo/tests/test_attacks.cairo`, `evm/test/attack.test.js`):
forged and spoofed inbound messages; releases larger than the escrow; redirected
and double-spent claims; a re-entrant token during `claim`; donated tokens;
escrowing a victim's balance; unverified escrow; identity laundering through a
fresh EVM account; a revoked holder's every exit route; parking tokens on an
unmirrored wallet; replaying a stale record to undo a revocation; and every
privilege escalation the contracts expose.

**Compliance export** (`tools/compliance-export.test.js`): the real export tool,
spawned as a subprocess, against a real HTTP JSON-RPC endpoint serving real EVM
bytecode. Scope is the export path — reading a token's rules and turning them
into `apply_spec` calldata.
Covers the two cases no unit test can reach, because they exist only as the
difference between a chain's history and its current state — a country allowed
then withdrawn, and the max balance that has no getter anywhere and can only be
recovered from the latest event. Then the exported file through
`apply-compliance.js` to `apply_spec` calldata.

That endpoint is `evm/test/rpcnode.js`: a read-only JSON-RPC front end over the
same in-process chain the rest of the suite uses. Ganache ships no native module
for Node 22 and its JS fallback resets connections, and requiring a node binary
to run a test is worse than serving the chain already there. Read-only is not a
shortcut — the export tool never writes.

The cross-language boundary is pinned from both sides: the JS encoder's expected
felts in `tools/spec.test.js` and Cairo's actual derived Serde output in
`the_spec_serializes_to_the_felts_the_js_tool_produces`. Neither alone would
catch a reordered field.
