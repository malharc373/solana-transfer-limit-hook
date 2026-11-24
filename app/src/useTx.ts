import type { Instruction } from "@solana/kit";
import { useRef, useState } from "react";
import { send } from "./lib/chain.js";
import { TransactionFailed } from "./lib/errors.js";
import { rpc } from "./network.js";
import type { Session } from "./session.js";

export type TxState =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; text: string; signature: string }
  | { kind: "failed"; text: string; refused: boolean };

export function useTx(session: Session | null) {
  const [state, setState] = useState<TxState>({ kind: "idle" });
  const running = useRef(false); // a double click must not send twice

  async function run(label: string, done: string, build: () => Promise<Instruction[]>): Promise<boolean> {
    if (!session || running.current) return false;
    running.current = true;
    setState({ kind: "busy", label });
    try {
      const signature = await send(rpc, session.signer, await build());
      setState({ kind: "done", text: done, signature });
      return true;
    } catch (e) {
      const failed = e instanceof TransactionFailed ? e : null;
      const refused = failed !== null && !failed.sent;
      const text = failed ? failed.failure.message : e instanceof Error ? e.message : String(e);
      setState({ kind: "failed", text: refused ? `${text} Nothing was signed and no fee was paid.` : text, refused });
      return false;
    } finally {
      running.current = false;
    }
  }
  return { state, run, busy: state.kind === "busy", clear: () => setState({ kind: "idle" }) };
}
