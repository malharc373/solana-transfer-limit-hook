// Development only: registers two in-memory wallets through Wallet Standard, so the
// app's real connect, sign and disconnect code can be exercised without an extension.
// Imported behind `import.meta.env.DEV`; not in the built app.

import {
  generateKeyPairSigner,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  partiallySignTransaction,
} from "@solana/kit";
import { CHAIN, CLUSTER, rpc } from "../network.js";

const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4IDgiPjxjaXJjbGUgY3g9IjQiIGN5PSI0IiByPSI0IiBmaWxsPSIjZjRjNDMwIi8+PC9zdmc+";

async function register(name: string) {
  const signer = await generateKeyPairSigner();
  if (CLUSTER === "localnet") await rpc.requestAirdrop(signer.address, lamports(5_000_000_000n)).send();

  const features = ["solana:signTransaction"] as const;
  const account = { address: signer.address, publicKey: getAddressEncoder().encode(signer.address), chains: [CHAIN], features };
  let accounts: (typeof account)[] = [];
  const listeners = new Set<(p: { accounts: typeof accounts }) => void>();
  const setAccounts = (next: typeof accounts) => {
    accounts = next;
    listeners.forEach((l) => l({ accounts }));
  };

  const wallet = {
    version: "1.0.0",
    name,
    icon: ICON,
    chains: [CHAIN],
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => (setAccounts([account]), { accounts }) },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => setAccounts([]) },
      "standard:events": {
        version: "1.0.0",
        on: (_: "change", l: (p: { accounts: typeof accounts }) => void) => (listeners.add(l), () => listeners.delete(l)),
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ transaction }) => {
              const signed = await partiallySignTransaction([signer.keyPair], getTransactionDecoder().decode(transaction));
              return { signedTransaction: getTransactionEncoder().encode(signed) };
            }),
          ),
      },
    },
  };
  const callback = ({ register }: { register: (w: unknown) => void }) => register(wallet);
  dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  addEventListener("wallet-standard:app-ready", (e) => callback((e as CustomEvent).detail));
}

await Promise.all(["Dev issuer", "Dev holder"].map(register));
