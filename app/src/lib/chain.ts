import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { explain, TransactionFailed } from "./errors.js";

export type AppRpc = ReturnType<typeof createSolanaRpc>;

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Cluster = "devnet" | "localnet" | "unknown";
export function clusterOf(url: string): Cluster {
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return "localnet";
  return host.includes("devnet") ? "devnet" : "unknown";
}

export async function assertNotMainnet(rpc: AppRpc): Promise<void> {
  if ((await retry(() => rpc.getGenesisHash().send())) === MAINNET_GENESIS) {
    throw new Error("This app is a devnet demo and refuses to run on mainnet.");
  }
}

/** Public endpoints rate-limit with HTTP 429; wait and try again. */
export async function retry<T>(call: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
      if (status !== 429 || i >= attempts) throw e;
      await sleep(1000 * i);
    }
  }
}

/**
 * Simulates first, so a transfer the hook will refuse is caught before the wallet
 * asks for a signature and before any fee is paid. Then signs, sends and confirms.
 */
export async function send(rpc: AppRpc, payer: TransactionSigner, instructions: Instruction[]): Promise<string> {
  const { value: blockhash } = await retry(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const unsigned = getBase64EncodedWireTransaction(compileTransaction(message));
  const { value: sim } = await retry(() =>
    rpc.simulateTransaction(unsigned, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send(),
  );
  if (sim.err) throw new TransactionFailed(explain(sim.logs ?? [], sim.err), false);

  const tx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(tx);
  await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send());

  for (let i = 0; i < 60; i++) {
    const { value: [status] } = await retry(() => rpc.getSignatureStatuses([signature]).send());
    if (status?.err) throw new TransactionFailed(explain([], status.err), true);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await sleep(1000);
  }
  throw new Error(`Not confirmed after a minute. Check ${signature} in the explorer before trying again: it may still land.`);
}
