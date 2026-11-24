import { useState } from "react";
import { formatAmount, parseAmount } from "./lib/amount.js";
import { createTokenInstructions, fundHolderInstructions, NEW_TOKEN_DECIMALS, setLimitInstruction } from "./lib/token.js";
import { formatDuration, splitWindow, UNITS, type Unit } from "./lib/window.js";
import { rpc } from "./network.js";
import { addressError, asAddress, Field, TxNotice, useToken } from "./parts.js";
import { Short, type Session } from "./session.js";
import { useTx } from "./useTx.js";

export function Issue({ session, mint, onMint }: { session: Session | null; mint: string; onMint: (v: string) => void }) {
  const { token, problem, loading, reload } = useToken(mint);
  const [tx, fundTx, changeTx] = [useTx(session), useTx(session), useTx(session)];
  const limit = useLimit(NEW_TOKEN_DECIMALS);

  if (!session) return <div className="panel"><p className="empty">Connect a wallet to issue a token. It becomes the issuer: it can mint, fund wallets and change the limit.</p></div>;

  return (
    <div className="panel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!limit.value) return;
          const { amount, secs } = limit.value;
          let created = "";
          void tx
            .run("Creating the token", "Token created.", async () => {
              const next = await createTokenInstructions(rpc, session.signer, amount, secs);
              created = next.mint;
              return next.instructions;
            })
            .then((ok) => ok && onMint(created));
        }}
      >
        <h2>Create a limited token</h2>
        <LimitFields {...limit} />
        <button disabled={!limit.value || tx.busy}>Create token</button>
        <TxNotice state={tx.state} />
      </form>

      <section>
        <h2>Manage a token</h2>
        <Field label="Token mint" value={mint} onChange={onMint} placeholder="Mint address" error={addressError(mint) ?? problem} />
        {loading && <p className="empty">Reading the token</p>}
        {token && (
          <>
            <p className="facts">
              Each wallet can send {formatAmount(token.limit, token.decimals)} per {formatDuration(token.windowSecs)}. Supply {formatAmount(token.supply, token.decimals)}. Issuer <Short value={token.issuer} />
            </p>
            {token.mintAuthority === session.address ? (
              <Fund key={token.mint} {...{ session, token }} tx={fundTx} onDone={reload} />
            ) : (
              <p className="hint">Only the mint authority can fund wallets.</p>
            )}
            {token.issuer === session.address ? (
              <Change key={`${token.mint}/${token.limit}/${token.windowSecs}`} {...{ session, token }} tx={changeTx} onDone={reload} />
            ) : (
              <p className="hint">Only the issuer can change the limit.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

type Managed = { session: Session; token: NonNullable<ReturnType<typeof useToken>["token"]>; tx: ReturnType<typeof useTx>; onDone: () => Promise<void> };

function Fund({ session, token, tx, onDone }: Managed) {
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const owner = asAddress(to);
  const amount = parseAmount(text, token.decimals);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!owner || !amount) return;
        void tx
          .run("Funding the wallet", `Minted ${formatAmount(amount, token.decimals)}. The wallet's allowance is open.`, () => fundHolderInstructions(rpc, session.signer, token, owner, amount))
          .then((ok) => { if (ok) setText(""); return onDone(); });
      }}
    >
      <h3>Fund a wallet</h3>
      <div className="row">
        <Field label="Wallet" value={to} onChange={setTo} placeholder="Wallet address" error={addressError(to)} />
        <Field label="Amount to mint" numeric value={text} onChange={setText} placeholder="1,000" error={text && !amount ? "Enter an amount above zero." : null} />
      </div>
      <button disabled={!owner || !amount || tx.busy}>Fund wallet</button>
      <TxNotice state={tx.state} />
    </form>
  );
}

function Change({ session, token, tx, onDone }: Managed) {
  const limit = useLimit(token.decimals, token);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!limit.value) return;
        const { amount, secs } = limit.value;
        void tx.run("Changing the limit", "Limit changed. It applies to the next transfer.", async () => [await setLimitInstruction(session.signer, token.mint, amount, secs)]).then(onDone);
      }}
    >
      <h3>Change the limit</h3>
      <LimitFields {...limit} />
      <button disabled={!limit.value || tx.busy}>Change limit</button>
      <TxNotice state={tx.state} />
    </form>
  );
}

/** Starts from `current` when editing, so changing one field never changes the other. */
function useLimit(decimals: number, current?: { limit: bigint; windowSecs: bigint }) {
  const start = current ? splitWindow(current.windowSecs) : { count: 1n, unit: "days" as const };
  const [text, setText] = useState(current ? formatAmount(current.limit, decimals) : "100");
  const [every, setEvery] = useState(start.count.toString());
  const [unit, setUnit] = useState<Unit>(start.unit);
  const amount = parseAmount(text, decimals);
  const count = /^\d{1,10}$/.test(every.trim()) ? BigInt(every.trim()) : 0n;
  const value = amount && count > 0n ? { amount, secs: count * UNITS[unit] } : null;
  return { text, setText, every, setEvery, unit, setUnit, amount, count, value };
}

function LimitFields(p: ReturnType<typeof useLimit>) {
  return (
    <div className="row">
      <Field label="Each wallet can send" numeric value={p.text} onChange={p.setText} error={p.amount === null ? "Enter an amount above zero." : null} />
      <Field label="Every" numeric value={p.every} onChange={p.setEvery} error={p.count === 0n ? "Enter a whole number above zero." : null}>
        <select aria-label="Window unit" value={p.unit} onChange={(e) => p.setUnit(e.target.value as Unit)}>
          {Object.keys(UNITS).map((u) => <option key={u}>{u}</option>)}
        </select>
      </Field>
    </div>
  );
}
