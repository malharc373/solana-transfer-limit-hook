// Runs the app's own functions against a local validator with the real program:
//   solana-test-validator --reset --bpf-program <program id> ../target/deploy/transfer_limit_hook.so
//   E2E_RPC=http://127.0.0.1:8899 npm test
import { createSolanaRpc, generateKeyPairSigner, lamports, type Address, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, test } from "vitest";
import { send } from "../src/lib/chain.js";
import { TransactionFailed } from "../src/lib/errors.js";
import {
  createTokenInstructions,
  fundHolderInstructions,
  loadHolder,
  loadToken,
  openUsageInstruction,
  setLimitInstruction,
  transferInstructions,
  type LimitedToken,
} from "../src/lib/token.js";
import { allowance } from "../src/lib/window.js";

const url = process.env.E2E_RPC;
const U = 1_000_000n;
const WINDOW = 12n;

describe.skipIf(!url)("against a validator", () => {
  const rpc = createSolanaRpc(url ?? "http://127.0.0.1:8899");
  let issuer: KeyPairSigner, alice: KeyPairSigner, bob: KeyPairSigner, mint: Address, token: LimitedToken;

  const reload = async () => {
    const found = await loadToken(rpc, mint);
    if (found.kind !== "limited") throw new Error(found.reason);
    token = found.token;
  };
  const left = async (owner: Address) => {
    const h = await loadHolder(rpc, mint, owner);
    return h.spent && allowance(token, h.spent, h.now);
  };
  const pay = async (from: KeyPairSigner, to: Address, amount: bigint) => send(rpc, from, await transferInstructions(rpc, from, token, to, amount));
  const refusal = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(TransactionFailed);
    return e as TransactionFailed;
  };

  beforeAll(async () => {
    [issuer, alice, bob] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    for (const k of [issuer, alice, bob]) {
      await rpc.requestAirdrop(k.address, lamports(5_000_000_000n)).send();
      while ((await rpc.getBalance(k.address, { commitment: "confirmed" }).send()).value === 0n) await new Promise((r) => setTimeout(r, 300));
    }
    const created = await createTokenInstructions(rpc, issuer, 100n * U, WINDOW);
    mint = created.mint;
    await send(rpc, issuer, created.instructions);
    await reload();
  }, 60_000);

  test("a new token reads back with its limit and issuer", () => {
    expect(token).toMatchObject({ limit: 100n * U, windowSecs: WINDOW, issuer: issuer.address, decimals: 6, supply: 0n });
  });

  test("funding a holder opens their allowance, and funding again does not fail", async () => {
    await send(rpc, issuer, await fundHolderInstructions(rpc, issuer, token, alice.address, 1000n * U));
    await send(rpc, issuer, await fundHolderInstructions(rpc, issuer, token, alice.address, 5n * U));
    expect((await loadHolder(rpc, mint, alice.address)).balance).toBe(1005n * U);
    expect((await left(alice.address))?.remaining).toBe(100n * U);
  }, 60_000);

  test("within the limit it moves; over it, simulation refuses before signing; then the window rolls over", async () => {
    await pay(alice, bob.address, 60n * U); // bob's token account is created in the same transaction
    expect((await loadHolder(rpc, mint, bob.address)).balance).toBe(60n * U);
    expect((await left(alice.address))?.remaining).toBe(40n * U);

    const before = (await rpc.getBalance(alice.address, { commitment: "confirmed" }).send()).value;
    const e = await refusal(pay(alice, bob.address, 41n * U));
    expect(e.failure.hookCode).toBe(6000);
    expect(e.sent).toBe(false);
    expect((await rpc.getBalance(alice.address, { commitment: "confirmed" }).send()).value).toBe(before);

    while ((await left(alice.address))?.resetsIn !== null) await new Promise((r) => setTimeout(r, 500));
    await pay(alice, bob.address, 100n * U);
    expect((await left(alice.address))?.remaining).toBe(0n);
  }, 90_000);

  test("a holder without an allowance account is refused until they open one", async () => {
    expect((await loadHolder(rpc, mint, bob.address)).spent).toBeNull();
    expect((await refusal(pay(bob, alice.address, U))).failure.hookCode).toBe(6001);
    await send(rpc, bob, [await openUsageInstruction(bob, mint, bob.address)]);
    await pay(bob, alice.address, U);
  }, 60_000);

  test("only the issuer can change the limit, and it applies at once", async () => {
    expect((await refusal(send(rpc, alice, [await setLimitInstruction(alice, mint, 1n, 1n)]))).failure.hookCode).toBe(6004);
    await send(rpc, issuer, [await setLimitInstruction(issuer, mint, 5n * U, 3600n)]);
    await reload();
    expect(token).toMatchObject({ limit: 5n * U, windowSecs: 3600n });
    expect((await refusal(pay(bob, alice.address, 5n * U))).failure.hookCode).toBe(6000);
  }, 60_000);

  test("the issuer is exempt", async () => {
    await send(rpc, issuer, await fundHolderInstructions(rpc, issuer, token, issuer.address, 500n * U));
    await pay(issuer, bob.address, 500n * U);
  }, 60_000);

  test("sending more than the balance is explained as a balance problem", async () => {
    await send(rpc, issuer, [await setLimitInstruction(issuer, mint, 1_000_000n * U, 3600n)]);
    expect((await refusal(pay(alice, bob.address, 500_000n * U))).failure.message).toMatch(/enough tokens/);
  }, 60_000);

  test("addresses that are not limited tokens get a reason", async () => {
    const nothing = await generateKeyPairSigner();
    expect(await loadToken(rpc, nothing.address)).toMatchObject({ kind: "none", reason: expect.stringMatching(/No account/) });
    expect(await loadToken(rpc, alice.address)).toMatchObject({ kind: "none", reason: expect.stringMatching(/not a Token-2022/) });
  }, 60_000);

});
