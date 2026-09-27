#!/usr/bin/env node
// Move the bridge onto a new main Veil pool.
//
//   node --env-file=.env migrate-pool.js --factory 0x... [--new-pool 0x...]
//                                        [--direct-access open|closed]
//
//   1. create_pool on `--factory`, with the OLD pool's auditor key (skipped
//      when --new-pool names one already created);
//   2. replicate the old pool's setup onto it, read from the old pool's own
//      events and getters: every token it lists (same kind, registry,
//      compliance, permission manager, role or rules) and every adapter it
//      allows -- except the cash vault and exit, which are bound to one pool
//      and are redeployed with deploy-cash.js;
//   3. per asset: the gateway delivers into the new pool (set_pool) and
//      trusts the new factory (set_factory), and the mirrored registry admits
//      the new pool as a holder with the country it gave the old one;
//   4. direct access: a new pool starts with `deposit` / `withdraw` closed (a
//      bridge pool: value in only through adapter-filled notes, out only
//      through `invoke`). The main pool operates inside Starknet, so it is
//      opened unless `--direct-access closed`.
//
// Idempotent: every step reads first and skips what is already right. The old
// pool is recorded as `veil.previousPool`; notes held there stay there.

const { hash } = require('starknet');
const {
  parseArgs, loadDeployment, saveDeployment, requireEnv, starknetAccount, asFelts, step, done,
} = require('./lib');
const { network } = require('./config');

const KIND_ERC3643 = 1n;
const KIND_ALLOWLIST = 2n;
const KIND_RULES = 3n;
const h = (v) => '0x' + BigInt(v).toString(16);

async function main() {
  const args = parseArgs(process.argv);
  if (!args.factory) throw new Error('--factory is required');
  const net = network(args.starknet);
  const [rpc, address, key] = requireEnv('STARKNET_RPC_URL', 'STARKNET_ACCOUNT_ADDRESS', 'STARKNET_PRIVATE_KEY');
  const { provider, account } = starknetAccount(rpc, address, key);
  const d = loadDeployment(args);
  const oldPool = d.veil?.previousPool && args['new-pool'] ? d.veil.previousPool : d.veil?.pool;
  if (!oldPool) throw new Error('no current pool in the deployment');
  const call = async (to, entrypoint, calldata = []) =>
    asFelts(await provider.callContract({ contractAddress: to, entrypoint, calldata })).map(BigInt);
  const run = async (label, calls) => {
    if (!calls.length) return;
    for (let i = 0; i < calls.length; i += 10) {
      const res = await account.execute(calls.slice(i, i + 10));
      await provider.waitForTransaction(res.transaction_hash);
      done(`${label} (${Math.min(i + 10, calls.length)}/${calls.length})`, res.transaction_hash,
        `${net.explorer}/tx/${res.transaction_hash}`);
    }
  };

  // ---- 1. the new pool --------------------------------------------------
  step(1, 4, 'the new pool');
  const auditor = (await call(oldPool, 'get_auditor_public_key'))[0];
  let pool = args['new-pool'] ?? d.veil?.migratingTo;
  if (pool) {
    done('using', pool);
  } else {
    const res = await account.execute({ contractAddress: args.factory, entrypoint: 'create_pool', calldata: [h(auditor)] });
    const receipt = await provider.waitForTransaction(res.transaction_hash);
    const created = receipt.events.find((e) => BigInt(e.from_address) === BigInt(args.factory));
    pool = h(created.keys[2]);
    d.veil = { ...(d.veil ?? {}), migratingTo: pool };
    saveDeployment(args, d);
    done('created', pool, `${net.explorer}/contract/${pool}`);
  }
  if ((await call(args.factory, 'get_pool_owner', [pool]))[0] !== BigInt(address)) {
    throw new Error(`${pool} is not a pool of ${args.factory} owned by ${address}`);
  }
  if ((await call(pool, 'get_auditor_public_key'))[0] !== auditor) throw new Error('auditor key differs from the old pool');

  // ---- 2. the old pool's setup, replicated ------------------------------
  step(2, 3, 'tokens and adapters, as the old pool has them');
  const names = ['TokenAllowed', 'AllowlistTokenAllowed', 'RulesTokenAllowed', 'AdapterSet'];
  const sel = Object.fromEntries(names.map((n) => [BigInt(hash.getSelectorFromName(n)), n]));
  const tokens = new Set();
  const adapters = new Set();
  let token;
  do {
    const r = await provider.getEvents({
      address: oldPool, keys: [Object.keys(sel).map(h)], from_block: { block_number: 0 },
      to_block: 'latest', chunk_size: 1000, continuation_token: token,
    });
    for (const e of r.events) {
      if (sel[BigInt(e.keys[0])] === 'AdapterSet') adapters.add(h(e.keys[1]));
      else tokens.add(h(e.keys[1]));
    }
    token = r.continuation_token;
  } while (token);

  const skip = new Set([d.cash?.vault, d.cash?.exit].filter(Boolean).map((a) => BigInt(a)));
  const listings = [];
  for (const t of tokens) {
    if ((await call(oldPool, 'is_token_allowed', [t]))[0] !== 1n) continue;
    const kind = (await call(oldPool, 'get_token_kind', [t]))[0];
    if ((await call(pool, 'is_token_allowed', [t]))[0] === 1n
        && (await call(pool, 'get_token_kind', [t]))[0] === kind) continue;
    if (kind === KIND_ALLOWLIST) {
      const pm = (await call(oldPool, 'get_token_permission_manager', [t]))[0];
      const role = (await call(oldPool, 'get_token_whitelist_role', [t]))[0];
      listings.push({ contractAddress: pool, entrypoint: 'add_allowlisted_token', calldata: [t, h(pm), h(role)] });
    } else if (kind === KIND_RULES) {
      const rules = (await call(oldPool, 'get_token_rules', [t]))[0];
      listings.push({ contractAddress: pool, entrypoint: 'add_rules_token', calldata: [t, h(rules)] });
    } else {
      const registry = (await call(oldPool, 'get_token_registry', [t]))[0];
      const compliance = (await call(oldPool, 'get_token_compliance', [t]))[0];
      listings.push({ contractAddress: pool, entrypoint: 'add_token', calldata: [t, h(registry), h(compliance)] });
    }
  }
  const allow = [];
  for (const a of adapters) {
    if (skip.has(BigInt(a))) continue;
    if ((await call(oldPool, 'is_adapter_allowed', [a]))[0] !== 1n) continue;
    if ((await call(pool, 'is_adapter_allowed', [a]))[0] === 1n) continue;
    allow.push({ contractAddress: pool, entrypoint: 'set_adapter_allowed', calldata: [a, '1'] });
  }
  console.log(`      ${listings.length} token listing(s), ${allow.length} adapter(s) to replicate`);
  await run('listed', listings);
  await run('adapters', allow);

  // ---- 3. every bridge asset delivers into it ---------------------------
  step(3, 4, 'gateways deliver into the new pool; registries admit it as a holder');
  const wiring = [];
  for (const [id, slot] of Object.entries(d.assets ?? {})) {
    const sn = slot.starknet ?? {};
    if (!sn.gateway || !sn.registry) continue;
    if ((await call(sn.gateway, 'pool'))[0] !== BigInt(pool)) {
      wiring.push({ contractAddress: sn.gateway, entrypoint: 'set_pool', calldata: [pool] });
    }
    if ((await call(sn.gateway, 'factory'))[0] !== BigInt(args.factory)) {
      wiring.push({ contractAddress: sn.gateway, entrypoint: 'set_factory', calldata: [args.factory] });
    }
    const was = await call(sn.registry, 'local_identity', [oldPool]);
    const now = await call(sn.registry, 'local_identity', [pool]);
    const country = was[1] ?? 840n;
    if (now[0] !== 1n || now[1] !== country) {
      wiring.push({ contractAddress: sn.registry, entrypoint: 'set_local_identity', calldata: [pool, '1', h(country)] });
    }
    sn.pool = pool;
    console.log(`      ${id}`);
  }
  await run('wired', wiring);

  // ---- 4. direct access -------------------------------------------------
  const open = (args['direct-access'] ?? 'open') !== 'closed';
  step(4, 4, `direct access ${open ? 'open' : 'closed'} (deposit / withdraw)`);
  const enabled = (await call(pool, 'is_direct_access_enabled'))[0] === 1n;
  if (enabled === open) {
    done('already', open ? 'open' : 'closed');
  } else {
    await run('set', [{ contractAddress: pool, entrypoint: 'set_direct_access', calldata: [open ? '1' : '0'] }]);
  }

  d.veil = { ...(d.veil ?? {}), previousPool: oldPool, pool, factory: args.factory };
  delete d.veil.migratingTo;
  saveDeployment(args, d);
  console.log(`\nmain pool is now ${pool}`);
  console.log('next: node --env-file=.env deploy-cash.js   (cash vault and exit for the new pool)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
