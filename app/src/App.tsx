import { isAddress } from "@solana/kit";
import { useSelectedWalletAccount } from "@solana/react";
import { useEffect, useState } from "react";
import { Issue } from "./Issue.js";
import { assertNotMainnet } from "./lib/chain.js";
import { CLUSTER, rpc } from "./network.js";
import { WalletButtons, WithWallet, type Session } from "./session.js";
import { Spend } from "./Spend.js";

// The mint from the devnet demo run linked in the README: something to look at on arrival.
const SAMPLE = { mint: "DqbPzobZ5LCpe8Mzyeetk4HvLMN4uuNX8Z4RLeiAkd2E", wallet: "2QqTDsgMv8Tx48fCpSNNtWCrL4dRvU74kYHJxfzMTRdN" };

type Tab = "spend" | "issue";
const param = (name: string) => {
  const v = new URLSearchParams(location.search).get(name);
  return v && isAddress(v) ? v : "";
};

export function App() {
  const [account] = useSelectedWalletAccount();
  const [tab, setTab] = useState<Tab>("spend");
  const [mint, setMint] = useState<string>(() => param("mint"));
  const [watch, setWatch] = useState<string>(() => param("wallet"));
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    assertNotMainnet(rpc).catch((e: Error) => {
      if (/mainnet/.test(e.message)) setBlocked(e.message);
    });
  }, []);
  useEffect(() => {
    const q = new URLSearchParams();
    if (isAddress(mint)) q.set("mint", mint);
    if (isAddress(watch)) q.set("wallet", watch);
    history.replaceState(null, "", q.size ? `?${q}` : location.pathname);
  }, [mint, watch]);

  const body = (session: Session | null) =>
    tab === "spend" ? (
      <Spend
        key={session?.address ?? "none"}
        session={session}
        mint={mint}
        onMint={setMint}
        watch={watch}
        onWatch={setWatch}
        onSample={CLUSTER === "localnet" ? null : () => { setMint(SAMPLE.mint); setWatch(SAMPLE.wallet); }}
      />
    ) : (
      <Issue key={session?.address ?? "none"} session={session} mint={mint} onMint={setMint} />
    );

  return (
    <>
      <header>
        <div>
          <h1>Sluice</h1>
          <p>A token that limits how much each wallet can send per window. The program checks it inside every transfer, so a leaked key can only move one window's worth.</p>
        </div>
        <div className="session">
          <WalletButtons />
          <p className="hint">{CLUSTER === "localnet" ? "Local validator" : "Devnet. Tokens here have no value."}</p>
        </div>
      </header>
      <main>
        {blocked ? (
          <p className="notice bad" role="alert">{blocked}</p>
        ) : (
          <>
            <nav aria-label="Sections">
              <button aria-current={tab === "spend" ? "page" : undefined} onClick={() => setTab("spend")}>Spend</button>
              <button aria-current={tab === "issue" ? "page" : undefined} onClick={() => setTab("issue")}>Issue</button>
            </nav>
            {account ? <WithWallet key={account.address} account={account}>{body}</WithWallet> : body(null)}
          </>
        )}
      </main>
      <footer>
        <a href="https://github.com/malharc373/solana-transfer-limit-hook">Source and security notes</a>
        <span>Not audited.</span>
      </footer>
    </>
  );
}

