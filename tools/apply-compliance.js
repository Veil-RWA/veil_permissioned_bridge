#!/usr/bin/env node
// Turn an exported ComplianceSpec into the Starknet call that replicates it.
//
//   node apply-compliance.js --spec compliance-spec.json --compliance <address>
//
//   --network <name>   passed through to sncast (default sepolia)
//   --account <name>   sncast account profile (default default)
//   --json             print the calldata as JSON instead of a command
//
// Prints a ready-to-run `sncast invoke` for `MirroredCompliance.apply_spec`.
// Nothing is sent from here: replication is the step where an issuer's rules
// get committed, so it should be a command the operator reads and runs, not a
// side effect of a script that also did the reading.
//
// After it lands, verify rather than trust: call `export_spec` on the same
// contract and diff it against the spec file. `apply_spec` REPLACES the rule
// set, so re-running with a narrower spec correctly clears what the old one set.

const fs = require('fs');
const { toCalldata, fromJSON, toJSON } = require('./spec');

function parseArgs(argv) {
  const out = { network: 'sepolia', account: 'default', json: false };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'json') {
      out.json = true;
      continue;
    }
    const value = argv[++i];
    if (key === 'spec') out.spec = value;
    else if (key === 'compliance') out.compliance = value;
    else if (key === 'network') out.network = value;
    else if (key === 'account') out.account = value;
    else throw new Error(`unknown option --${key}`);
  }
  if (!out.spec || !out.compliance) {
    throw new Error('usage: apply-compliance.js --spec <path> --compliance <address> [--network <name>] [--account <name>] [--json]');
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const file = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
  // Accept either the exporter's { spec, report } envelope or a bare spec.
  const spec = fromJSON(file.spec || file);
  const calldata = toCalldata(spec).map((v) => v.toString());

  if (args.json) {
    console.log(JSON.stringify({ spec: toJSON(spec), calldata }, null, 2));
    return;
  }

  const summary = toJSON(spec);
  console.log('Replicating this rule set:');
  console.log(`  country allow      ${summary.countryAllowEnabled ? summary.allowedCountries.join(', ') || '(none -- blocks everyone)' : 'off'}`);
  console.log(`  country restrict   ${summary.countryRestrictEnabled ? summary.restrictedCountries.join(', ') || '(none)' : 'off'}`);
  console.log(`  max balance        ${summary.maxBalanceEnabled ? summary.maxBalance : 'off'}`);
  console.log(`  supply limit       ${summary.supplyLimitEnabled ? summary.supplyLimit : 'off'}`);
  console.log(`  transfer restrict  ${summary.transferRestrictEnabled ? `${summary.allowedIdentities.length} identities` : 'off'}`);

  if (file.report && file.report.unmirrored && file.report.unmirrored.length) {
    console.log('\nNOT carried across (the source token enforces these, the twin will not):');
    for (const m of file.report.unmirrored) console.log(`  ${m.name} -- ${m.reason}`);
  }
  if (summary.countryAllowEnabled && summary.allowedCountries.length === 0) {
    console.log('\nWARNING: country allow is ON with an empty list, which blocks every transfer.');
  }

  console.log('\nRun:');
  console.log(
    `  sncast --account ${args.account} invoke \\\n` +
    `    --network ${args.network} \\\n` +
    `    --contract-address ${args.compliance} \\\n` +
    `    --function apply_spec \\\n` +
    `    --calldata ${calldata.join(' ')}`
  );
  console.log('\nThen verify:');
  console.log(
    `  sncast --account ${args.account} call --network ${args.network} \\\n` +
    `    --contract-address ${args.compliance} --function export_spec`
  );
}

try {
  main();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
