import { createSolanaRpc } from "@solana/kit";
import { clusterOf } from "./lib/chain.js";

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com";
export const CLUSTER = clusterOf(RPC_URL);
// A custom RPC host is treated as devnet; mainnet is ruled out by genesis hash at startup.
export const CHAIN = CLUSTER === "localnet" ? "solana:localnet" : "solana:devnet";
export const rpc = createSolanaRpc(RPC_URL);

export function explorer(kind: "tx" | "address", id: string): string {
  const cluster = CLUSTER === "localnet" ? `custom&customUrl=${encodeURIComponent(RPC_URL)}` : "devnet";
  return `https://explorer.solana.com/${kind}/${id}?cluster=${cluster}`;
}
