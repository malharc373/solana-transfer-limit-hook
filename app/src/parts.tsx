import { isAddress, type Address } from "@solana/kit";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { loadToken, type LimitedToken, type TokenLookup } from "./lib/token.js";
import { explorer, rpc } from "./network.js";
import type { TxState } from "./useTx.js";

export function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; error?: string | null; numeric?: boolean; children?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <div className="control">
        <input
          id={id}
          value={props.value}
          placeholder={props.placeholder}
          inputMode={props.numeric ? "decimal" : "text"}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? `${id}-e` : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.children}
      </div>
      {props.error && <p className="error" id={`${id}-e`}>{props.error}</p>}
    </div>
  );
}

export function TxNotice({ state }: { state: TxState }) {
  return (
    <div className="status" aria-live="polite">
      {state.kind === "busy" && <p className="notice">{state.label}</p>}
      {state.kind === "done" && (
        <p className="notice good">
          {state.text} <a href={explorer("tx", state.signature)} target="_blank" rel="noreferrer">View transaction</a>
        </p>
      )}
      {state.kind === "failed" && <p className="notice bad">{state.text}</p>}
    </div>
  );
}

export const asAddress = (v: string): Address | null => (isAddress(v.trim()) ? (v.trim() as Address) : null);
export const addressError = (v: string) => (v.trim() && !asAddress(v) ? "This is not a Solana address." : null);

type Loaded = { mint: Address; lookup: TokenLookup } | { mint: Address; error: string } | null;

/** The token at `text`, reloadable. Ignores answers for an address that is no longer asked for. */
export function useToken(text: string) {
  const mint = asAddress(text);
  const [loaded, setLoaded] = useState<Loaded>(null);
  const asked = useRef<Address | null>(null);
  asked.current = mint;

  const reload = useCallback(async () => {
    if (!mint) return;
    const next: Loaded = await loadToken(rpc, mint).then(
      (lookup) => ({ mint, lookup }),
      () => ({ mint, error: "Could not reach the network. Check your connection and try again." }),
    );
    if (asked.current === mint) setLoaded(next);
  }, [mint]);
  useEffect(() => void reload(), [reload]);

  const current = loaded && loaded.mint === mint ? loaded : null;
  const token: LimitedToken | null = current && "lookup" in current && current.lookup.kind === "limited" ? current.lookup.token : null;
  const problem = current ? ("error" in current ? current.error : current.lookup.kind === "none" ? current.lookup.reason : null) : null;
  return { token, problem, loading: mint !== null && current === null, reload };
}
