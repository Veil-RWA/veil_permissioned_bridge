# Deployment

Testnet runbook. Every script is resumable — addresses are written to
`../deployments/<evm>__<starknet>.json` as soon as they exist, so a failure at
step 5 does not mean paying for steps 1–4 again.

```bash
cd scripts
npm install
cp .env.example .env    # then fill it in
set -a && . ./.env && set +a
```

There are **two** environment files, loaded by different tools and kept apart on
purpose:

| File | Holds | Secret? |
|---|---|---|
| `scripts/.env` | `EVM_*` and `STARKNET_*` RPCs, account and **private keys** | Yes — gitignored, use throwaway testnet accounts |
| `frontend/.env` | RPCs, which deployment to load, the prover endpoint | No — Vite inlines it into the bundle |

Nothing in `frontend/.env` is a secret and the app never needs a key: it signs
with the user's wallet. The app also runs with that file blank; only "Create my
open note" needs anything set there. Each file lists which script or feature
needs which variable.

You need: a funded EVM account (gas + the LayerZero message fee, in ETH), a
funded Starknet account (fees in STRK), and an ERC-3643 token. On mainnet that
token belongs to an issuer and this bridge does not issue one. On testnet there
is no issuer, so step 0 deploys faucet assets instead.

## Assets

Every step takes `--asset <id>`, one of `gold`, `silver`, `tbill`, `credit`,
`estate` — the catalogue in `frontend/src/assets.ts`. **Each asset gets its own
lockbox, gateway, registry, compliance and twin.** The escrow is never shared: a
shared lockbox would let one issuer's pause or compromise reach another issuer's
holders, and would blur the escrow invariant. So run the sequence below once per
asset. Class declarations are cached across assets, so the second one is cheaper.

The Veil **pool** is the exception and is NOT per asset — one pool carries any
number of them, so every asset lands in the same main pool. See step 6.

## 0. No ERC-3643 asset to bridge? Deploy a faucet one

The bridge escrows an asset that already exists and belongs to an issuer, so
`deploy-evm.js` does not create one. On testnet there is no issuer:

```bash
node deploy-faucet.js --asset gold --evm ethereum-sepolia [--modules]
```

That deploys a REAL ERC-3643 token — full transfer gate, identity registry,
modular compliance — with a public `claim()` that registers the caller and mints
to them. Anyone can then get a permissioned balance without being
hand-registered:

```bash
cast send <token> "claim()" --rpc-url $EVM_RPC_URL --private-key $KEY
```

`--modules` additionally deploys the five T-REX modules, bound but unconfigured,
so `export-compliance.js` has something real to enumerate. Configure them with
`--max-balance` / `--supply-limit`, or by calling the modules directly.

The faucet is the only testnet-shaped part: on a real asset, registration is the
issuer's KYC decision and minting is theirs. Everything else is the production
gate, so a bridge-out that fails here fails for the reason it would against an
issuer's token.

**After it, register the lockbox** — `deploy-evm.js` prints the command. T-REX
verifies the RECIPIENT of a transfer and on a bridge-out that is the lockbox, so
without it every escrow reverts inside the token.

## Already deployed? Skip to the addresses

If the contracts exist and you just have their addresses:

```bash
node set-addresses.js --asset gold \
  --lockbox 0x... --token 0x... \
  --registry 0x... --gateway 0x... --compliance 0x... --twin 0x...
```

It writes the same deployment file the deploy scripts produce, so `wire.js`,
`bridge.js` and the app pick it up with no further steps. Shapes are validated:
a Starknet address in an EVM slot is rejected rather than failing later inside a
contract call.

## 1. EVM side

```bash
node deploy-evm.js --asset gold --token 0x<erc3643>
```

Deploys `VeilERC3643Lockbox` for that asset, and `ComplianceReader` once —
it is stateless and asset-agnostic, so later assets reuse it.

## 2. Starknet side

```bash
(cd ../cairo && scarb build)
node deploy-starknet.js --asset gold --name "Bridged Gold" --symbol bXAU --staleness 86400
```

Deploys the mirror, gateway, compliance and the twin. `--staleness` is the
maximum time a revocation on the source chain can go unenforced on the twin;
`0` disables expiry and is devnet-only.

## 3. Wire

```bash
node wire.js --asset gold
```

Sets the internal links and the peers **on both sides**. Idempotent: it reads
current on-chain state and skips anything already correct.

Setting one side's peer and bridging immediately is the classic way to strand a
message — the receiver rejects it with `ONLY_PEER`. `wire.js` does both.

## 4. The issuer registers the lockbox

**Nothing works until this happens.** T-REX verifies the *recipient* of every
transfer, and on a bridge-out the recipient is the lockbox:

```
identityRegistry.registerIdentity(<lockbox>, <identity>, <country>)
```

Only the issuer's agent can do it. That is the authorisation model, not an
obstacle: the issuer's consent is a live on-chain switch they can withdraw.

## 5. Replicate the compliance rules

```bash
cd ../tools
node export-compliance.js --rpc $EVM_RPC_URL --token 0x<erc3643> \
  --reader 0x<complianceReader> --out spec.json
node apply-compliance.js --spec spec.json --compliance 0x<MirroredCompliance>
```

Read the report before applying. It names any module it could **not** mirror,
and flags the max balance as event-derived — the only field with no getter to
confirm against.

## 6. Pool delivery (optional)

**Required, not optional.** Every bridge-in lands in a Veil pool note — there is
no wallet delivery — so a gateway without a pool quarantines everything.

**A Veil pool is multi-asset**: one pool carries any number of ERC-3643 tokens.
So the pool is not per-asset — every asset this bridge carries lands in the same
one. `wire.js` defaults to the **main Veil pool** for the target network and
records it once at deployment level, so in the normal case there is nothing to
pass:

```bash
node wire.js --asset gold          # uses the main Veil pool + factory
```

Override either with `--pool` / `--factory`. `--factory` is the
`VeilERC3643Factory`: it is what lets a sender address a transfer to an entity's
OWN pool, because `create_pool` is the only way a pool exists and it records the
deployer, so the gateway can tell a real pool from a pasted address. Without a
factory wired, only the default pool is reachable.

Three more things, and the first two are on the POOL's side:

1. The pool allow-lists the gateway: `set_adapter_allowed(<gateway>, true)`.
   Without it every fill is declined and the amount lands in the wallet.
2. The gateway registers the pool as an eligible holder of the twin — the pool
   is a Starknet contract with no EVM identity, so it cannot receive one
   otherwise:

```bash
node wire.js --asset gold --holder 0x<veil-pool>
```

   Do this for **every** pool that should be reachable, the main one included:
   a pool the twin's registry has never heard of cannot hold it, however
   genuine the factory says it is.

3. Each holder needs an **open note** to fill. The bridge does not create one —
   that is the pool's proven `create_open_note` path. The app derives the
   holder's note id from their viewing key, finds one that is still fillable,
   and says so when there is none.

Then the holder claims it on the gateway (`register_note`, one transaction from
the app) so nobody else can name it. `fill_open_note` is one-shot and note ids
are public, so without a claim anyone could burn a note with dust.

## 7. Bridge one, for real

```bash
cd ../scripts
node bridge.js --asset gold --amount 1000000000000000000 --to 0x<starknet address>
```

Checks the preconditions, quotes the fee from the real endpoint, escrows, sends,
then polls Starknet until the twin supply moves — or until the amount shows up
quarantined, which is a compliance answer rather than a failure.

A message takes minutes: DVN verification then executor delivery. If it does not
arrive, the printed GUID and tx hash are what you take to
[layerzeroscan.com](https://testnet.layerzeroscan.com). Stuck in `VERIFYING`
means the DVN config; stuck after verification usually means the executor ran
out of gas — retry with a larger `--gas-limit`.

## DVN configuration

Sending with no explicit config uses the pathway defaults, which is fine for a
testnet run. Before mainnet, set the send/receive libraries and the DVN set
deliberately: that configuration *is* the security of the bridge, since a
compromised pathway can mint twin supply. Check what you have on LayerZero Scan.
