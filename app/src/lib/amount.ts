// Decimal strings to base units and back, without floating point.

const U64_MAX = 2n ** 64n - 1n;

/** Returns null when `text` is not a positive amount with at most `decimals` places. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/.exec(text.trim().replaceAll(",", ""));
  if (!m) return null;
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt(whole + frac.padEnd(decimals, "0"));
  return units > 0n && units <= U64_MAX ? units : null;
}

export function formatAmount(units: bigint, decimals: number): string {
  const digits = units.toString().padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  const whole = digits.slice(0, cut).replace(/\B(?=(\d{3})+$)/g, ",");
  const frac = digits.slice(cut).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
