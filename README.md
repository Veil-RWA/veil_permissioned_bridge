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
    tests/        82 tests (incl. 26 attack, 8 contract-holder)
  evm/            EVM side — own solc build + harness
    contracts/    VeilERC3643Lockbox, ComplianceReader, BridgeMsgCodec, lz/
    test/         41 tests (incl. 15 attack tests) + a JSON-RPC test node
  tools/          export/apply the compliance rule set — 7 unit + 11 e2e
  scripts/        testnet deployment: deploy, wire, bridge one for real
  frontend/       the bridge app (Vite + TypeScript)
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

## Why a bridge-in lands in a wallet, not a pool note

A bridge-in mints to the recipient's wallet: a public balance. It is tempting to
deliver it straight into a Veil pool note instead, so the position arrives
confidential. **That cannot be done safely from an inbound message**, and the
reason is worth recording so it is not attempted again.

The pool's `fill_open_note` is one-shot and is guarded only by an adapter
allowlist. The pool deliberately stores no per-note depositor, because it
assumes an allowlisted filler is **proof-bound** — in the intended flow the
filler is the target of an Invoke action, and which note it fills is fixed by a
proof the user produced.

A bridge-in has no user proof at arrival. A gateway that filled notes would be
an allowlisted adapter taking its `note_id` from an unauthenticated cross-chain
message, so anyone could name any note id — note ids are public, they are a
`#[key]` on `OpenNoteCreated` — and brick it with a dust fill. That is precisely
the hole the allowlist exists to close, reopened one level up. No amount of
guarding inside the bridge fixes it: the bridge cannot tell whether a note
belongs to the recipient, because the pool does not expose a note's owner.

So the recipient deposits into the pool themselves after arrival, through the
normal proven path, where the fill is bound to their proof. It costs a second
transaction and the balance is briefly public.

Making it atomic would need a change on the pool side — a note owner readable
on-chain, or a depositor binding on the fill — and that is a decision for the
pool, not something a bridge should route around.

## What the bridge publishes, and what it deliberately does not

A permissioned bridge has to make eligibility checkable on-chain, so the mirror
holds `sn_account -> evm_account` in readable storage and the twin reads it
before every transfer. That much is the mechanism and cannot be hidden.

What it does not have to do is **serve that pairing as an indexed log**. A Cairo
`Map` cannot be enumerated — storage only answers about an address you already
hold — whereas events can be scraped wholesale and `#[key]` makes them
filterable. So no event carries a cross-chain pairing or a KYC attribute:

| Removed | From | Why |
|---|---|---|
| `evm_sender` | `BridgeInMinted`, `BridgeInQuarantined` | free "every bridge-in from address X" filter; the `guid` already ties a mint to its origin |
| `evm_recipient` | `BridgeBackSent` | same, outbound |
| `snRecipient` | `BridgedOut` (EVM) | indexed pair on the source side |
| `country` | `IdentityApplied`, `ComplianceSynced` | KYC attribute nothing reads back; indexed it becomes "every holder from country X" |
| `bound_to`, `attempted` | `BindingConflict` | the operator knows `sn_account`; the rest is a storage read |
| `evm_account` | `WalletBound` | the pairing itself |

`evm_account` stays on `IdentityApplied` and `IdentityDropped`: without it an
operator cannot tell which record moved and the event is useless.

**Be clear about the limit.** This raises the cost of enumeration; it does not
make bridged positions private. The pairing is still derivable — enumerate
recipients from the twin's ERC-20 transfers, then call `identity_of` per
address — and the LayerZero message payload carries `evm_sender` and
`sn_recipient` in plaintext, since the gateway needs the recipient to mint. A
bridged position is identified at arrival. The pool protects what happens after,
not the entry.

## Contracts holding the twin

Eligibility is derived from an EVM binding, and a Starknet **contract** — a Veil
pool, an AMM, a lending market — has no EVM counterpart. Left there, the twin
could only ever move between bridged wallets, which makes it useless in any
protocol.

So infrastructure is registered directly with `set_local_identity`, exactly as a
T-REX agent registers a pool in an identity registry on its own chain:

```bash
node wire.js --asset gold --holder 0x<pool> --holder 0x<router>
```

It is deliberately **not** subject to the staleness window: there is no source
record to expire. Borrowing an investor's binding via `admin_rebind` instead
would appear to work and then start failing when that record aged out — a trap,
not a workaround.

It remains subject to everything else: a global pause stops it, the token's own
freeze stops it, and only the owner can grant it. Each of those is tested.

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
| 1 `MINT` | EVM → SN | 109 | evm_sender, sn_recipient, amount, seq, verified, frozen, country |
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

One lockbox and one twin per asset. Assets are not pooled: a shared lockbox
would let one issuer's pause or compromise reach another's holders, and would
blur the escrow invariant that `total_supply + total_pending` on Starknet equals
what is escrowed on EVM.

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

## Does the app need the Veil SDK?

**No.** The bridge touches the lockbox, the gateway, the mirror and the twin —
plain contract calls over ethers and starknet.js. The SDK (`sdk/` in the pool
repo) is proof machinery: notes, viewing keys, nullifiers, DvP, the prover.
None of it is on a bridging path, and the app has no dependency on it.

Depositing the bridged tokens into a Veil pool afterwards **does** need the SDK
— proofs, viewing keys, the derive/settle pair. That belongs in the pool's own
app, which already exists, rather than being reimplemented here. This app stops
at the wallet.

## The app

`frontend/` is a Vite + TypeScript app in the shape of a bridge UI: sticky
Transfer/History nav, one centred card, a vertical From → To stack, quote
details inline above the action button.

It carries **multiple assets** — gold, silver, treasuries, private credit and
real estate in the shipped catalogue (`frontend/src/assets.ts`). Picking one
switches the entire contract set, not just a ticker, because there is one
lockbox and one twin per asset and they are never pooled. Assets the current
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

## Toolchain requirements, learned the hard way

**starknet.js v10 is mandatory.** Live Sepolia serves RPC spec 0.10.x; v6 speaks
0.7 and cannot talk to the network at all. Both the scripts and the app are on
v10. Its `Account` constructor takes an options object — passing the old
positional form silently reads the provider as the options bag and fails later
with `Cannot read properties of undefined`.

`get-starknet` is gone: v10 ships `WalletAccount`, and wallet discovery is a
dozen lines over `window.starknet_*`. One less dependency pinned to an older
starknet.js.

**The old Blast API endpoints are discontinued** and return an error telling you
to migrate. Anything defaulting to them fails immediately. The defaults now
point at `starknet-sepolia.drpc.org`, verified serving 0.10.3.

**starknet-devnet cannot run these contracts.** 0.7.1 and 0.9.1 both reject
Sierra 1.8.0 (`No matching CasmContractClass found`). Sepolia accepts it —
verified against a live scarb-2.17 class on chain. Devnet is only useful here
for exercising the scripts up to the declare.

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
bash test.sh                        # everything, 141 tests
(cd cairo && snforge test)          # 82
(cd evm/script && bash test.sh)     # 41
(cd tools && node spec.test.js)     # 7
(cd tools && node e2e.test.js)      # 11
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

**End to end** (`tools/e2e.test.js`): the real export tool, spawned as a
subprocess, against a real HTTP JSON-RPC endpoint serving real EVM bytecode.
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
