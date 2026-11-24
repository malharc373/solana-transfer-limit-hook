// Who is acting: a browser wallet, or in development a throwaway key.

import type { Address, TransactionSigner } from "@solana/kit";
import { useSelectedWalletAccount, useWalletAccountTransactionSigner } from "@solana/react";
import { useConnect, useDisconnect, type UiWallet, type UiWalletAccount } from "@wallet-standard/react";
import { useState, type ReactNode } from "react";
import { CHAIN } from "./network.js";

export type Session = { address: Address; signer: TransactionSigner };

/** `useWalletAccountTransactionSigner` needs an account, so it lives in its own component. */
export function WithWallet({ account, children }: { account: UiWalletAccount; children: (s: Session) => ReactNode }) {
  const signer = useWalletAccountTransactionSigner(account, CHAIN);
  return children({ address: signer.address as Address, signer });
}

export function WalletButtons() {
  const [account, setAccount, wallets] = useSelectedWalletAccount();
  if (account) {
    const wallet = wallets.find((w) => w.accounts.some((a) => a.address === account.address));
    return (
      <div className="who">
        <Short value={account.address} />
        {wallet?.features.includes("standard:disconnect") ? (
          <Disconnect wallet={wallet} onDone={() => setAccount(undefined)} />
        ) : (
          <button className="quiet" onClick={() => setAccount(undefined)}>Disconnect</button>
        )}
      </div>
    );
  }
  if (wallets.length === 0) return <p className="hint">No Solana wallet found in this browser. You can still look up any token below.</p>;
  return <div className="who">{wallets.map((w) => <Connect key={w.name} wallet={w} onAccount={setAccount} />)}</div>;
}

function Connect({ wallet, onAccount }: { wallet: UiWallet; onAccount: (a: UiWalletAccount) => void }) {
  const [busy, connect] = useConnect(wallet);
  const [failed, setFailed] = useState(false);
  return (
    <button
      className="quiet"
      disabled={busy}
      onClick={async () => {
        setFailed(false);
        try {
          const accounts = await connect();
          const usable = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
          if (usable) onAccount(usable);
        } catch {
          setFailed(true);
        }
      }}
    >
      <img src={wallet.icon} alt="" width={18} height={18} />
      {busy ? "Connecting" : failed ? `Try ${wallet.name} again` : `Connect ${wallet.name}`}
    </button>
  );
}

function Disconnect({ wallet, onDone }: { wallet: UiWallet; onDone: () => void }) {
  const [busy, disconnect] = useDisconnect(wallet);
  return (
    <button className="quiet" disabled={busy} onClick={() => void disconnect().catch(() => {}).finally(onDone)}>
      Disconnect
    </button>
  );
}

export function Short({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="address"
      title={value}
      onClick={() =>
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }, () => {})
      }
    >
      {copied ? "Copied" : `${value.slice(0, 4)}…${value.slice(-4)}`}
    </button>
  );
}
