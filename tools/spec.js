// The ComplianceSpec: one shape, three representations.
//
// It is produced by `export-compliance.js` from a live EVM token, stored as
// JSON so it can be reviewed and version-controlled, and serialized to Starknet
// calldata by `apply-compliance.js` for `MirroredCompliance.apply_spec`.
//
// The field ORDER below is load-bearing: Cairo's derived Serde encodes a struct
// in declaration order, so this must stay in lockstep with `ComplianceSpec` in
// cairo/src/compliance/rules.cairo. `spec.test.js` pins it.

/// The five T-REX modules this bridge reproduces, by their on-chain `name()`.
const MIRRORED_MODULES = [
  'CountryAllowModule',
  'CountryRestrictModule',
  'MaxBalanceModule',
  'SupplyLimitModule',
  'TransferRestrictModule',
];

/// Modules that exist in T-REX but are deliberately NOT reproduced, with the
/// reason. Each is a stateful per-transfer rule whose source-chain accounting
/// (rolling windows, per-exchange counters, accrued fees, pre-approvals) cannot
/// be reconstructed from a snapshot, so a "mirror" of one would be a guess.
const UNMIRRORED_MODULES = {
  TimeTransfersLimitsModule: 'rolling per-investor time windows; counters are source-chain state',
  TimeExchangeLimitsModule: 'rolling per-exchange time windows; same problem',
  ExchangeMonthlyLimitsModule: 'monthly per-exchange counters; same problem',
  ConditionalTransferModule: 'per-transfer pre-approvals granted on the source chain',
  TransferFeesModule: 'fees are collected on the source chain; the twin has no fee path',
  TokenListingRestrictionsModule: 'governs listing on the source chain, not holder eligibility',
};

function emptySpec() {
  return {
    countryAllowEnabled: false,
    allowedCountries: [],
    countryRestrictEnabled: false,
    restrictedCountries: [],
    maxBalanceEnabled: false,
    maxBalance: 0n,
    supplyLimitEnabled: false,
    supplyLimit: 0n,
    transferRestrictEnabled: false,
    allowedIdentities: [],
  };
}

const U128 = 1n << 128n;
/// Cairo's u256 is two felts, low limb first.
const u256 = (v) => [BigInt(v) % U128, BigInt(v) / U128];
const bool = (v) => (v ? 1n : 0n);

/// Serialize to Starknet calldata, matching Cairo's derived Serde exactly:
/// fields in declaration order, an Array<T> as its length followed by its
/// elements, a u256 as (low, high), a bool as 0 or 1.
function toCalldata(spec) {
  const out = [];
  out.push(bool(spec.countryAllowEnabled));
  out.push(BigInt(spec.allowedCountries.length), ...spec.allowedCountries.map(BigInt));
  out.push(bool(spec.countryRestrictEnabled));
  out.push(BigInt(spec.restrictedCountries.length), ...spec.restrictedCountries.map(BigInt));
  out.push(bool(spec.maxBalanceEnabled));
  out.push(...u256(spec.maxBalance));
  out.push(bool(spec.supplyLimitEnabled));
  out.push(...u256(spec.supplyLimit));
  out.push(bool(spec.transferRestrictEnabled));
  out.push(BigInt(spec.allowedIdentities.length), ...spec.allowedIdentities.map(BigInt));
  return out;
}

/// JSON-safe form. BigInts become decimal strings; identities stay 0x-prefixed
/// so an EVM address is still recognizable to a human reviewing the file.
function toJSON(spec) {
  return {
    countryAllowEnabled: spec.countryAllowEnabled,
    allowedCountries: spec.allowedCountries.map(Number),
    countryRestrictEnabled: spec.countryRestrictEnabled,
    restrictedCountries: spec.restrictedCountries.map(Number),
    maxBalanceEnabled: spec.maxBalanceEnabled,
    maxBalance: spec.maxBalance.toString(),
    supplyLimitEnabled: spec.supplyLimitEnabled,
    supplyLimit: spec.supplyLimit.toString(),
    transferRestrictEnabled: spec.transferRestrictEnabled,
    allowedIdentities: spec.allowedIdentities.map(
      (a) => '0x' + BigInt(a).toString(16).padStart(40, '0')
    ),
  };
}

function fromJSON(json) {
  return {
    countryAllowEnabled: !!json.countryAllowEnabled,
    allowedCountries: (json.allowedCountries || []).map(Number),
    countryRestrictEnabled: !!json.countryRestrictEnabled,
    restrictedCountries: (json.restrictedCountries || []).map(Number),
    maxBalanceEnabled: !!json.maxBalanceEnabled,
    maxBalance: BigInt(json.maxBalance || 0),
    supplyLimitEnabled: !!json.supplyLimitEnabled,
    supplyLimit: BigInt(json.supplyLimit || 0),
    transferRestrictEnabled: !!json.transferRestrictEnabled,
    allowedIdentities: (json.allowedIdentities || []).map((a) => BigInt(a)),
  };
}

/// Reduce add/remove event args to the candidate set to probe, first-seen order.
///
/// Removals are deliberately NOT applied here. A country that was allowed,
/// withdrawn, then allowed again must still be probed, and only the live getter
/// decides whether it counts. Applying removals here would drop it and silently
/// under-replicate the rule set.
function candidatesFromLogs(values) {
  const seen = [];
  for (const value of values) {
    const key = typeof value === 'bigint' ? value.toString() : String(value).toLowerCase();
    if (!seen.some((s) => s.key === key)) seen.push({ key, value });
  }
  return seen.map((s) => s.value);
}

module.exports = {
  candidatesFromLogs,
  MIRRORED_MODULES,
  UNMIRRORED_MODULES,
  emptySpec,
  toCalldata,
  toJSON,
  fromJSON,
};
