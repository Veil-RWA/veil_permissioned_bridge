#!/usr/bin/env node
// Read a live ERC-3643 token's compliance rule set and write it out as a
// ComplianceSpec, ready to replicate onto its Starknet twin.
//
//   node export-compliance.js --rpc <url> --token <address> [options]
//
//   --reader <address>   deployed ComplianceReader, batches the probes
//   --from-block <n>     first block to scan for config events (default 0)
//   --out <path>         where to write the spec (default ./compliance-spec.json)
//
// Why it works the way it does. T-REX modules expose per-item getters and no
// enumeration, and MaxBalanceModule exposes NOTHING -- its cap is private and
// visible only through the `MaxBalanceSet` event. So neither source alone is
// enough:
//
//   events alone  -> shows history, including countries and users since removed
//   getters alone -> cannot enumerate; you would have to guess what to ask about
//
// This tool therefore uses events to learn the CANDIDATES and live getters to
// decide which candidates are STILL in force. The result matches the chain, not
// its history. The one exception is the max balance, which has no getter to
// confirm against: the latest `MaxBalanceSet` value is taken as authoritative
// and flagged in the report as event-derived.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const {
  MIRRORED_MODULES,
  UNMIRRORED_MODULES,
  emptySpec,
  toJSON,
  candidatesFromLogs,
} = require('./spec');

const TOKEN_ABI = [
  'function compliance() view returns (address)',
  'function identityRegistry() view returns (address)',
  'function paused() view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];
const COMPLIANCE_ABI = ['function getModules() view returns (address[])'];
const MODULE_ABI = [
  'function name() pure returns (string)',
  'function isCountryAllowed(address,uint16) view returns (bool)',
  'function isCountryRestricted(address,uint16) view returns (bool)',
  'function isUserAllowed(address,address) view returns (bool)',
  'function getSupplyLimit(address) view returns (uint256)',
  'event CountryAllowed(address _compliance, uint16 _country)',
  'event CountryUnallowed(address _compliance, uint16 _country)',
  'event AddedRestrictedCountry(address indexed _compliance, uint16 _country)',
  'event RemovedRestrictedCountry(address indexed _compliance, uint16 _country)',
  'event UserAllowed(address _compliance, address _userAddress)',
  'event UserDisallowed(address _compliance, address _userAddress)',
  'event MaxBalanceSet(address indexed _compliance, uint256 indexed _maxBalance)',
  'event SupplyLimitSet(address _compliance, uint256 _limit)',
];
const READER_ABI = [
  'function probeCountriesAllowed(address,address,uint16[]) view returns (bool[])',
  'function probeCountriesRestricted(address,address,uint16[]) view returns (bool[])',
  'function probeUsersAllowed(address,address,address[]) view returns (bool[])',
];

function parseArgs(argv) {
  const out = { fromBlock: 0, out: path.join(process.cwd(), 'compliance-spec.json') };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'rpc') out.rpc = value;
    else if (key === 'token') out.token = value;
    else if (key === 'reader') out.reader = value;
    else if (key === 'from-block') out.fromBlock = Number(value);
    else if (key === 'out') out.out = value;
    else throw new Error(`unknown option --${key}`);
  }
  if (!out.rpc || !out.token) {
    throw new Error('usage: export-compliance.js --rpc <url> --token <address> [--reader <address>] [--from-block <n>] [--out <path>]');
  }
  return out;
}

/// Candidate set from add/remove events, in the order first seen. Removal
/// events are NOT applied here -- a country removed and re-added must survive,
/// and the live probe below is what decides either way.
async function candidatesFrom(provider, module, fromBlock, addEvent, removeEvent, field) {
  const iface = new ethers.Interface(MODULE_ABI);
  const values = [];
  for (const name of [addEvent, removeEvent]) {
    const topic = iface.getEvent(name).topicHash;
    let logs = [];
    try {
      logs = await provider.getLogs({ address: module, topics: [topic], fromBlock, toBlock: 'latest' });
    } catch (e) {
      throw new Error(
        `could not read ${name} logs from ${module}: ${e.shortMessage || e.message}\n` +
        `  Some RPC providers cap the block range. Re-run with --from-block closer to deployment.`
      );
    }
    for (const log of logs) values.push(iface.parseLog(log).args[field]);
  }
  return candidatesFromLogs(values);
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = new ethers.JsonRpcProvider(args.rpc);
  const token = new ethers.Contract(args.token, TOKEN_ABI, provider);
  const reader = args.reader ? new ethers.Contract(args.reader, READER_ABI, provider) : null;

  const complianceAddr = await token.compliance();
  const report = {
    token: args.token,
    compliance: complianceAddr,
    identityRegistry: await token.identityRegistry().catch(() => null),
    modules: [],
    unmirrored: [],
    warnings: [],
  };
  try {
    report.name = await token.name();
    report.symbol = await token.symbol();
  } catch (_) {}

  const compliance = new ethers.Contract(complianceAddr, COMPLIANCE_ABI, provider);
  const moduleAddrs = await compliance.getModules();
  const spec = emptySpec();

  for (const addr of moduleAddrs) {
    const module = new ethers.Contract(addr, MODULE_ABI, provider);
    let name = '';
    try {
      name = await module.name();
    } catch (_) {
      report.warnings.push(`module ${addr} has no readable name(); skipped`);
      continue;
    }
    report.modules.push({ address: addr, name });

    if (!MIRRORED_MODULES.includes(name)) {
      report.unmirrored.push({
        address: addr,
        name,
        reason: UNMIRRORED_MODULES[name] || 'unrecognized module; not part of the mirrored set',
      });
      continue;
    }

    if (name === 'CountryAllowModule') {
      const candidates = await candidatesFrom(
        provider, addr, args.fromBlock, 'CountryAllowed', 'CountryUnallowed', '_country'
      );
      spec.allowedCountries = await confirmCountries(reader, module, addr, complianceAddr, candidates, true);
      spec.countryAllowEnabled = true;
    } else if (name === 'CountryRestrictModule') {
      const candidates = await candidatesFrom(
        provider, addr, args.fromBlock, 'AddedRestrictedCountry', 'RemovedRestrictedCountry', '_country'
      );
      spec.restrictedCountries = await confirmCountries(reader, module, addr, complianceAddr, candidates, false);
      spec.countryRestrictEnabled = true;
    } else if (name === 'TransferRestrictModule') {
      const candidates = await candidatesFrom(
        provider, addr, args.fromBlock, 'UserAllowed', 'UserDisallowed', '_userAddress'
      );
      const live = [];
      if (reader && candidates.length) {
        const flags = await reader.probeUsersAllowed(addr, complianceAddr, candidates);
        candidates.forEach((u, i) => flags[i] && live.push(BigInt(u)));
      } else {
        for (const u of candidates) {
          if (await module.isUserAllowed(complianceAddr, u).catch(() => false)) live.push(BigInt(u));
        }
      }
      spec.allowedIdentities = live;
      spec.transferRestrictEnabled = true;
      report.warnings.push(
        'TransferRestrictModule allow-list is keyed on EVM addresses. On Starknet the same ' +
        'entries key on the EVM identity behind each wallet, which is the faithful mapping, ' +
        'but it means a holder must have bridged at least once to be recognized.'
      );
    } else if (name === 'SupplyLimitModule') {
      spec.supplyLimit = await module.getSupplyLimit(complianceAddr);
      spec.supplyLimitEnabled = true;
    } else if (name === 'MaxBalanceModule') {
      // No getter exists. The latest MaxBalanceSet event is the only source.
      const iface = new ethers.Interface(MODULE_ABI);
      const topic = iface.getEvent('MaxBalanceSet').topicHash;
      const complianceTopic = ethers.zeroPadValue(complianceAddr, 32);
      const logs = await provider.getLogs({
        address: addr, topics: [topic, complianceTopic], fromBlock: args.fromBlock, toBlock: 'latest',
      });
      if (!logs.length) {
        report.warnings.push(
          `MaxBalanceModule at ${addr} is bound but no MaxBalanceSet event was found from block ` +
          `${args.fromBlock}. The cap has NO on-chain getter, so it cannot be recovered any other ` +
          `way -- re-run with an earlier --from-block, or set maxBalance by hand before applying.`
        );
      } else {
        spec.maxBalance = iface.parseLog(logs[logs.length - 1]).args._maxBalance;
        spec.maxBalanceEnabled = true;
        report.warnings.push(
          `maxBalance=${spec.maxBalance} is EVENT-DERIVED (MaxBalanceModule exposes no getter), ` +
          `so unlike every other field it could not be confirmed against live state. Verify it ` +
          `before applying.`
        );
      }
    }
  }

  const output = { spec: toJSON(spec), report };
  fs.writeFileSync(args.out, JSON.stringify(output, null, 2) + '\n');

  console.log(`token       ${report.name || ''} ${report.symbol ? `(${report.symbol})` : ''} ${args.token}`);
  console.log(`compliance  ${complianceAddr}`);
  console.log(`modules     ${report.modules.length} bound, ${report.modules.length - report.unmirrored.length} mirrored`);
  console.log('');
  console.log(JSON.stringify(toJSON(spec), null, 2));
  if (report.unmirrored.length) {
    console.log('\nNOT mirrored -- these rules will NOT be enforced on the twin:');
    for (const m of report.unmirrored) console.log(`  ${m.name} (${m.address})\n    ${m.reason}`);
  }
  if (report.warnings.length) {
    console.log('\nWarnings:');
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
  console.log(`\nwritten to ${args.out}`);
  console.log(`next: node apply-compliance.js --spec ${args.out} --compliance <starknet address>`);
}

async function confirmCountries(reader, module, moduleAddr, complianceAddr, candidates, allowVariant) {
  if (!candidates.length) return [];
  const nums = candidates.map(Number);
  if (reader) {
    const flags = allowVariant
      ? await reader.probeCountriesAllowed(moduleAddr, complianceAddr, nums)
      : await reader.probeCountriesRestricted(moduleAddr, complianceAddr, nums);
    return nums.filter((_, i) => flags[i]);
  }
  const live = [];
  for (const c of nums) {
    const on = allowVariant
      ? await module.isCountryAllowed(complianceAddr, c).catch(() => false)
      : await module.isCountryRestricted(complianceAddr, c).catch(() => false);
    if (on) live.push(c);
  }
  return live;
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
