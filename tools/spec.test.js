// Pins the ComplianceSpec calldata encoding against Cairo's derived Serde.
//
// If these drift, `apply_spec` silently reads the wrong fields -- a max balance
// landing in a supply limit, say -- so the layout is asserted here rather than
// discovered on a testnet. The expectations mirror the field order in
// cairo/src/compliance/rules.cairo.

const assert = require('assert');
const { emptySpec, toCalldata, toJSON, fromJSON, candidatesFromLogs } = require('./spec');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

test('an empty spec encodes as all-off with empty arrays', () => {
  const cd = toCalldata(emptySpec()).map(String);
  //  allow=0, [], restrict=0, [], max=0, u256(0,0), supply=0, u256(0,0), tr=0, []
  assert.deepStrictEqual(cd, ['0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0']);
});

// The other half of this assertion lives in
// cairo/tests/test_compliance.cairo::the_spec_serializes_to_the_felts_the_js_tool_produces,
// which asserts the SAME vector against Cairo's actual derived Serde. Neither
// side alone would catch a reordered field; together they pin the boundary.
test('field order matches the Cairo struct declaration order', () => {
  const spec = {
    countryAllowEnabled: true,
    allowedCountries: [840, 250],
    countryRestrictEnabled: true,
    restrictedCountries: [408],
    maxBalanceEnabled: true,
    maxBalance: 5000n,
    supplyLimitEnabled: true,
    supplyLimit: 1000000n,
    transferRestrictEnabled: true,
    allowedIdentities: [0xa11cen],
  };
  assert.deepStrictEqual(toCalldata(spec).map(String), [
    '1',                    // country_allow_enabled
    '2', '840', '250',      // allowed_countries: len, items
    '1',                    // country_restrict_enabled
    '1', '408',             // restricted_countries
    '1',                    // max_balance_enabled
    '5000', '0',            // max_balance: u256 low, high
    '1',                    // supply_limit_enabled
    '1000000', '0',         // supply_limit
    '1',                    // transfer_restrict_enabled
    '1', '659918',          // allowed_identities: len, 0xA11CE
  ]);
});

test('a u256 above 2^128 splits into low and high limbs', () => {
  const spec = { ...emptySpec(), maxBalanceEnabled: true, maxBalance: (1n << 130n) + 7n };
  const cd = toCalldata(spec).map(String);
  // low limb is 7, high limb is 4 (2^130 = 4 * 2^128)
  assert.strictEqual(cd[5], '7', 'low limb');
  assert.strictEqual(cd[6], '4', 'high limb');
});

test('JSON round-trips without losing precision', () => {
  const spec = {
    ...emptySpec(),
    maxBalanceEnabled: true,
    maxBalance: 123456789012345678901234567890n,
    transferRestrictEnabled: true,
    allowedIdentities: [0xa11cen, 0xb0bn],
  };
  const back = fromJSON(toJSON(spec));
  assert.strictEqual(back.maxBalance, spec.maxBalance);
  assert.deepStrictEqual(back.allowedIdentities, spec.allowedIdentities);
  assert.deepStrictEqual(toCalldata(back), toCalldata(spec));
});

test('an EVM address stays readable as an address in the JSON', () => {
  // The identity a Starknet rule keys on IS the EVM account, so the spec file
  // should still show something a reviewer recognizes as an address.
  const addr = '0x00000000000000000000000000000000000a11ce';
  const spec = { ...emptySpec(), allowedIdentities: [BigInt(addr)] };
  assert.strictEqual(toJSON(spec).allowedIdentities[0], addr);
  assert.strictEqual(toCalldata(spec).at(-1), BigInt(addr));
});

test('candidate reconstruction keeps a re-added entry and dedupes', () => {
  // A country allowed, withdrawn, then allowed again must still be PROBED --
  // only the live getter decides. Applying removals here would drop it and
  // silently under-replicate the issuer's rules.
  const values = [840n, 250n, 840n, 250n, 408n];
  assert.deepStrictEqual(candidatesFromLogs(values), [840n, 250n, 408n]);
});

test('candidate reconstruction is case-insensitive for addresses', () => {
  // The same user logged from two events with different checksum casing is one
  // candidate, not two.
  const values = ['0xAbC0000000000000000000000000000000000001',
                  '0xabc0000000000000000000000000000000000001',
                  '0xDeF0000000000000000000000000000000000002'];
  assert.deepStrictEqual(candidatesFromLogs(values).length, 2);
});

console.log(`\n${passed} passed`);
