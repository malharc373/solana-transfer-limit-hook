// The window rule, exactly as `transfer_hook` applies it on-chain.

export type Limit = { limit: bigint; windowSecs: bigint };
export type Spent = { used: bigint; windowStart: bigint };

export type Allowance = {
  used: bigint;
  remaining: bigint;
  /** Seconds until the window rolls over; null when no window is open. */
  resetsIn: bigint | null;
};

/** What a wallet may still send at chain time `now`. */
export function allowance({ limit, windowSecs }: Limit, { used, windowStart }: Spent, now: bigint): Allowance {
  const elapsed = now - windowStart;
  // `>=`: a transfer exactly `windowSecs` after the start opens a new window.
  if (elapsed >= windowSecs) return { used: 0n, remaining: limit, resetsIn: null };
  return {
    used,
    // The issuer can lower the limit below what was already sent.
    remaining: used >= limit ? 0n : limit - used,
    resetsIn: windowSecs - elapsed,
  };
}

export function formatDuration(totalSecs: bigint): string {
  const s = Number(totalSecs);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s % 60 > 0 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${s} s`;
}

export const UNITS = { seconds: 1n, minutes: 60n, hours: 3600n, days: 86_400n } as const;
export type Unit = keyof typeof UNITS;

/** The largest unit that divides the window exactly: 90 s stays 90 seconds, 7200 s is 2 hours. */
export function splitWindow(secs: bigint): { count: bigint; unit: Unit } {
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (secs % UNITS[unit] === 0n) return { count: secs / UNITS[unit], unit };
  }
  return { count: secs, unit: "seconds" };
}
