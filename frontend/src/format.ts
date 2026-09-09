export function short(address: string, lead = 6, tail = 4): string {
  if (!address) return '';
  return address.length <= lead + tail + 2
    ? address
    : `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/// Format a base-unit integer for display without floating point.
export function units(value: bigint, decimals = 18, maxFraction = 6): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac ? '.' + frac : ''}`;
}

/// Parse a decimal string into base units. Throws on anything that is not a
/// plain non-negative decimal, rather than silently truncating.
export function parseUnits(input: string, decimals = 18): bigint {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    throw new Error('enter a number');
  }
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt((whole || '0') + frac.padEnd(decimals, '0'));
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function ago(timestamp: number): string {
  return `${duration((Date.now() - timestamp) / 1000)} ago`;
}
