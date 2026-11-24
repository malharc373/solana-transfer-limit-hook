// The sluice gauge: water is what the wallet has sent this window, hatching is the
// amount being typed, and the gate is the limit. Past the gate, the hook refuses.

import { formatAmount } from "./lib/amount.js";
import type { Allowance } from "./lib/window.js";
import { formatDuration } from "./lib/window.js";

type Props = { limit: bigint; windowSecs: bigint; decimals: number; state: Allowance; draft: bigint };

export function Gauge({ limit, windowSecs, decimals, state, draft }: Props) {
  const total = state.used + draft;
  // The gate sits at 80% of the tank; the tank stretches for an overflow, up to 2× the limit.
  const cap = limit * 2n;
  const shown = total > cap ? cap : total;
  const span = max((limit * 5n) / 4n, (shown * 21n) / 20n, 1n);
  const pct = (v: bigint) => `${Number((min(v, span) * 10_000n) / span) / 100}%`;
  const over = total > limit;

  const summary = state.resetsIn === null
    ? `No window is open. The next transfer starts one that lasts ${formatDuration(windowSecs)}.`
    : `This window ends in ${formatDuration(state.resetsIn)}.`;

  return (
    <section className={over ? "gauge over" : "gauge"}>
      <p className="left">
        <strong>{formatAmount(state.remaining, decimals)}</strong> left to send
      </p>
      <div
        className="tank"
        role="img"
        aria-label={`${formatAmount(state.used, decimals)} of ${formatAmount(limit, decimals)} sent in this window${draft > 0n ? `, sending ${formatAmount(draft, decimals)} more ${over ? "goes over the limit" : "fits"}` : ""}`}
      >
        <div className="water" style={{ width: pct(state.used) }} />
        <div className="draft" style={{ left: pct(state.used), width: diff(pct(min(shown, max(limit, state.used))), pct(state.used)) }} />
        {over && <div className="spill" style={{ left: pct(limit), width: diff(pct(shown), pct(limit)) }} />}
        <div className="gate" style={{ left: pct(limit) }}>
          <span>{formatAmount(limit, decimals)}</span>
        </div>
      </div>
      <p className="caption">
        {formatAmount(state.used, decimals)} sent. {summary}
      </p>
    </section>
  );
}

const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));
const max = (...v: bigint[]) => v.reduce((a, b) => (a > b ? a : b));
const diff = (a: string, b: string) => `${Math.max(0, parseFloat(a) - parseFloat(b))}%`;
