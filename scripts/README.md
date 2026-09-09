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

You need: a funded EVM account (gas + the LayerZero message fee, in ETH), a
funded Starknet account (fees in STRK), and **an ERC-3643 token that already
exists**. This bridge does not issue one — the whole premise is that the asset
belongs to an issuer.

## Assets

Every step takes `--asset <id>`, one of `gold`, `silver`, `tbill`, `credit`,
`estate` — the catalogue in `frontend/src/assets.ts`. **Each asset gets its own
lockbox, gateway, registry, compliance and twin.** Assets are never pooled: a
shared lockbox would let one issuer's pause or compromise reach another issuer's
holders, and would blur the escrow invariant. So run the sequence below once per
asset. Class declarations are cached across assets, so the second one is cheaper.

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

## 6. Bridge one, for real

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
