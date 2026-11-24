import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-500.css";
import "@fontsource/barlow/latin-600.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/barlow-semi-condensed/latin-700.css";
import "./styles.css";
import { SelectedWalletAccountContextProvider } from "@solana/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { CHAIN } from "./network.js";

if (import.meta.env.DEV) void import("./dev/wallets.js");

const KEY = "sluice:wallet";
const storage = <T,>(use: () => T, fallback: T): T => {
  try {
    return use();
  } catch {
    return fallback; // storage blocked: the wallet choice is just not remembered
  }
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SelectedWalletAccountContextProvider
      filterWallets={(w) => w.chains.includes(CHAIN) && w.features.includes("standard:connect")}
      stateSync={{
        getSelectedWallet: () => storage(() => localStorage.getItem(KEY), null),
        storeSelectedWallet: (k) => storage(() => localStorage.setItem(KEY, k), undefined),
        deleteSelectedWallet: () => storage(() => localStorage.removeItem(KEY), undefined),
      }}
    >
      <App />
    </SelectedWalletAccountContextProvider>
  </StrictMode>,
);
