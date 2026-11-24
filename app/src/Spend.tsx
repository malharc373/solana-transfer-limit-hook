import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge } from "./Gauge.js";
import { formatAmount, parseAmount } from "./lib/amount.js";
import { loadHolder, openUsageInstruction, transferInstructions, type Holder } from "./lib/token.js";
import { allowance, formatDuration } from "./lib/window.js";
import { rpc } from "./network.js";
import { addressError, asAddress, Field, TxNotice, useToken } from "./parts.js";
import { Short, type Session } from "./session.js";
import { useTx } from "./useTx.js";

const REFRESH_MS = 15_000;

type Props = { session: Session | null; mint: string; onMint: (v: string) => void; watch: string; onWatch: (v: string) => void; onSample: (() => void) | null };

export function Spend({ session, mint, onMint, watch, onWatch, onSample }: Props) {
  const { token, problem, loading, reload } = useToken(mint);
  const owner = asAddress(watch) ?? session?.address ?? null;
  const { holder, now, error, refresh } = useHolder(token?.mint ?? null, owner);
  const [to, setTo] = useState("");
  const [amountText, setAmountText] = useState("");
  const tx = useTx(session);

  const mine = session !== null && owner === session.address;
  const exempt = token !== null && owner === token.issuer;
  const amount = token ? parseAmount(amountText, token.decimals) : null;
  const recipient = asAddress(to);
  const state = token && holder?.spent && now !== null ? allowance(token, holder.spent, now) : null;
  const over = state !== null && !exempt && amount !== null && amount > state.remaining;
  const poor = holder !== null && amount !== null && amount > holder.balance;

  const after = async (ok: boolean) => {
    await Promise.all([refresh(), reload()]);
    if (ok) setAmountText("");
  };

  return (
    <div className="panel">
      <div className="row">
        <Field label="Token mint" value={mint} onChange={onMint} placeholder="Mint address" error={addressError(mint) ?? problem} />
        <Field label="Wallet" value={watch} onChange={onWatch} placeholder={session ? `Yours, ${session.address.slice(0, 4)}…${session.address.slice(-4)}` : "Wallet address"} error={addressError(watch)} />
      </div>

      {!mint && (
        <p className="empty">
          Paste a token to see how much a wallet may still send.
          {onSample && <button className="link" onClick={onSample}>Look at the demo token</button>}
        </p>
      )}
      {loading && <p className="empty">Reading the token</p>}
      {token && !owner && <p className="empty">Enter a wallet to see its allowance, or connect yours.</p>}
      {error && <p className="notice bad" role="alert">{error}</p>}

      {token && holder && (
        <>
          {exempt ? (
            <p className="notice">This wallet is the issuer. Its transfers are not limited.</p>
          ) : state ? (
            <Gauge limit={token.limit} windowSecs={token.windowSecs} decimals={token.decimals} state={state} draft={amount ?? 0n} />
          ) : (
            <div className="notice">
              <p>This wallet has no allowance account, so the hook refuses its transfers. The limit is {formatAmount(token.limit, token.decimals)} per {formatDuration(token.windowSecs)}.</p>
              {session && (
                <button
                  disabled={tx.busy}
                  onClick={() => void tx.run("Opening the allowance", "Allowance opened.", async () => [await openUsageInstruction(session.signer, token.mint, holder.owner)]).then(after)}
                >
                  Open allowance
                </button>
              )}
            </div>
          )}
          <p className="facts">
            Balance {formatAmount(holder.balance, token.decimals)}. Limit set by <Short value={token.issuer} />
          </p>
        </>
      )}

      <TxNotice state={tx.state} />

      {token && holder && mine && (state || exempt) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!amount || !recipient || !session) return;
            void tx
              .run("Checking with the program, then asking your wallet", `Sent ${formatAmount(amount, token.decimals)}.`, () => transferInstructions(rpc, session.signer, token, recipient, amount))
              .then(after);
          }}
        >
          <div className="row">
            <Field label="Amount" numeric value={amountText} onChange={(v) => { setAmountText(v); tx.clear(); }} placeholder="0" error={amountText && amount === null ? `Enter an amount above zero with at most ${token.decimals} decimals.` : poor ? "This is more than the wallet's balance." : null} />
            <Field label="Send to" value={to} onChange={setTo} placeholder="Recipient's wallet address" error={addressError(to)} />
          </div>
          {over && !poor && <p className="notice warn">This goes past the gate by {formatAmount(amount! - state!.remaining, token.decimals)}. If you send it anyway, the program will refuse.</p>}
          <button disabled={!amount || !recipient || tx.busy}>{over ? "Send anyway" : "Send"}</button>
        </form>
      )}
      {token && holder && !mine && <p className="hint">{session ? "Clear the wallet field to send from your own wallet." : "Connect this wallet to send from it."}</p>}
    </div>
  );
}

/** Polls the holder, and advances chain time between readings so the countdown moves. */
function useHolder(mint: LimitedMint, owner: LimitedMint) {
  const [reading, setReading] = useState<{ key: string; holder: Holder; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const key = `${mint}/${owner}`;
  const asked = useRef(key);
  asked.current = key;

  const refresh = useCallback(async () => {
    if (!mint || !owner) return;
    try {
      const holder = await loadHolder(rpc, mint, owner);
      if (asked.current !== key) return;
      setReading({ key, holder, at: performance.now() });
      setError(null);
    } catch {
      if (asked.current === key) setError("Could not read this wallet from the network. Trying again shortly.");
    }
  }, [mint, owner, key]);

  useEffect(() => {
    setError(null);
    void refresh();
    const poll = setInterval(() => document.visibilityState === "visible" && void refresh(), REFRESH_MS);
    const second = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(second);
    };
  }, [refresh]);

  const current = reading?.key === key ? reading : null;
  const now = current ? current.holder.now + BigInt(Math.floor((performance.now() - current.at) / 1000)) : null;
  return { holder: current?.holder ?? null, now, error, refresh };
}
type LimitedMint = Parameters<typeof loadHolder>[1] | null;
