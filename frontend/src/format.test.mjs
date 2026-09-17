// Twin units shown as tokens: a Securitize twin counts the token's 18-decimal
// shares, and a rebase changes how many shares a token is worth.
//
// Build first (test.sh does this):
//   npx esbuild src/format.ts --bundle --format=esm --platform=node \
//     --outfile=src/format.bundle.mjs

import { tokenScale, unitsToTokens, units, parseUnits } from './format.bundle.mjs';

let pass = 0;
const fail = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail.push(name); console.log('  FAIL  ' + name); }
}

const six = tokenScale(6);
ok('a plain asset is 1:1', unitsToTokens(123456n, six) === 123456n);

// BUIDL-like: 6 decimals, one token = 1e18 shares at a multiplier of 1.
const ds = { unitsPerToken: 10n ** 18n, decimals: 6 };
ok('1e18 shares is one token', unitsToTokens(10n ** 18n, ds) === 1_000_000n);
ok('shares format as tokens', units(unitsToTokens(2_500_000n * 10n ** 12n, ds), 6) === '2.5');

// After a 1.5x rebase one token is worth 2/3 of the shares.
const rebased = { unitsPerToken: 666_666_666_666_666_667n, decimals: 6 };
const shares = 100n * 10n ** 18n;
ok('a rebase re-prices the same shares', unitsToTokens(shares, rebased) === 149_999_999n);

// Rounded down: never shows more than a release would pay.
ok('dust rounds down to zero', unitsToTokens(10n ** 12n - 1n, ds) === 0n);
ok('parse then scale back', unitsToTokens(parseUnits('7', 6) * 10n ** 12n, ds) === 7_000_000n);

console.log(`\n${pass} passed${fail.length ? `, ${fail.length} failed` : ''}`);
if (fail.length) process.exit(1);
