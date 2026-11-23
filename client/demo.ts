// Devnet demo for the transfer-limit hook.
//   npm run demo
// 1. Creates a Token-2022 mint whose transfer hook is this program.
// 2. Sets a limit of 100 tokens per 60 s and mints 1,000 to a fresh wallet (Alice).
// 3. Alice sends 60 (ok), then tries 50 more: the hook rejects it.
// Env: RPC_URL (default devnet), KEYPAIR (issuer; default ~/.config/solana/id.json)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  extension,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  fetchUsage,
  findConfigPda,
  findExtraAccountMetaListPda,
  getInitializeInstructionAsync,
  getOpenUsageInstruction,
  TRANSFER_LIMIT_HOOK_PROGRAM_ADDRESS as HOOK,
} from "./src/generated/index.js";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER = RPC_URL.includes("devnet") ? "?cluster=devnet" : "";
const DECIMALS = 6;
const UNIT = 1_000_000n;
const rpc = createSolanaRpc(RPC_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}` : x));

/** Retries an RPC call when the public endpoint rate-limits us (HTTP 429). */
async function retry<T>(call: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
      if (status !== 429 || i >= attempts) throw e;
      await sleep(2000 * i);
    }
  }
}

/** Sends with preflight (so a rejected transfer fails before paying a fee) and polls over HTTP. */
async function send(payer: KeyPairSigner, ixs: Instruction[]): Promise<[string, bigint]> {
  const { value: blockhash } = await retry(() => rpc.getLatestBlockhash().send());
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
  const sig = getSignatureFromTransaction(tx);
  await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send());
  for (let i = 0; ; i++) {
    const { value: [status] } = await retry(() => rpc.getSignatureStatuses([sig]).send());
    if (status?.err) throw new Error(`${sig} failed: ${json(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
    if (i >= 60) throw new Error(`${sig} not confirmed after 120s`);
    await sleep(2000);
  }
  const info = await retry(() =>
    rpc.getTransaction(sig, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }).send(),
  );
  return [sig, info?.meta?.computeUnitsConsumed ?? 0n];
}

const log = (label: string, [sig, cu]: [string, bigint]) =>
  console.log(`  ${label.padEnd(22)} ${String(cu).padStart(6)} CU  https://explorer.solana.com/tx/${sig}${CLUSTER}`);
const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
const usagePda = async (mint: Address, owner: Address) =>
  (
    await getProgramDerivedAddress({
      programAddress: HOOK,
      seeds: ["usage", getAddressEncoder().encode(mint), getAddressEncoder().encode(owner)],
    })
  )[0];

/** transfer_checked plus the accounts Token-2022 needs to CPI into the hook. */
async function hookedTransfer(mint: Address, from: KeyPairSigner, to: Address, amount: bigint): Promise<Instruction> {
  const ix = getTransferCheckedInstruction({
    source: await ata(from.address, mint),
    mint,
    destination: await ata(to, mint),
    authority: from,
    amount,
    decimals: DECIMALS,
  });
  return {
    ...ix,
    accounts: [
      ...ix.accounts,
      { address: (await findConfigPda({ mint }))[0], role: AccountRole.READONLY },
      { address: await usagePda(mint, from.address), role: AccountRole.WRITABLE },
      { address: HOOK, role: AccountRole.READONLY },
      { address: (await findExtraAccountMetaListPda({ mint }))[0], role: AccountRole.READONLY },
    ],
  };
}

// ---------------------------------------------------------------------------
const path = process.env.KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
const issuer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
const [alice, bob, mint] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
console.log(`issuer ${issuer.address}\nalice  ${alice.address} (fresh)\nbob    ${bob.address} (fresh)\nmint   ${mint.address}\n`);

const space = BigInt(getMintSize([extension("TransferHook", { authority: issuer.address, programId: HOOK })]));
const lamports = await retry(() => rpc.getMinimumBalanceForRentExemption(space).send());
log("create hooked mint", await send(issuer, [
  getCreateAccountInstruction({ payer: issuer, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
  getInitializeTransferHookInstruction({ mint: mint.address, authority: issuer.address, programId: HOOK }),
  getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: issuer.address }),
]));

const [config] = await findConfigPda({ mint: mint.address });
log("limit 100 / 60s + fund", await send(issuer, [
  await getInitializeInstructionAsync({ authority: issuer, mint: mint.address, limit: 100n * UNIT, windowSecs: 60n }),
  getTransferSolInstruction({ source: issuer, destination: alice.address, amount: 20_000_000n }),
  getCreateAssociatedTokenIdempotentInstruction({ payer: issuer, ata: await ata(alice.address, mint.address), owner: alice.address, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
  getCreateAssociatedTokenIdempotentInstruction({ payer: issuer, ata: await ata(bob.address, mint.address), owner: bob.address, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
  getMintToCheckedInstruction({ mint: mint.address, token: await ata(alice.address, mint.address), mintAuthority: issuer, amount: 1_000n * UNIT, decimals: DECIMALS }),
  getOpenUsageInstruction({ payer: issuer, config, usage: await usagePda(mint.address, alice.address), owner: alice.address }),
]));

log("alice → bob 60", await send(alice, [await hookedTransfer(mint.address, alice, bob.address, 60n * UNIT)]));

try {
  await send(alice, [await hookedTransfer(mint.address, alice, bob.address, 50n * UNIT)]);
  throw new Error("expected the hook to reject the second transfer");
} catch (e) {
  const logs = (e as { context?: { logs?: string[] } }).context?.logs ?? [];
  const reason = logs.find((l) => l.includes("Error Code")) ?? String(e);
  console.log(`  alice → bob 50         rejected in preflight (no fee): ${reason.replace(/.*Error Code: /, "").split(".")[0]}`);
}

const aliceUsage = await usagePda(mint.address, alice.address);
const usage = await retry(() => fetchUsage(rpc, aliceUsage));
const bal = async (o: Address) => { const t = await ata(o, mint.address); return (await retry(() => fetchToken(rpc, t))).data.amount / UNIT; };
console.log(`\nalice used ${usage.data.used / UNIT} of 100 this window; balances: alice ${await bal(alice.address)}, bob ${await bal(bob.address)}`);
