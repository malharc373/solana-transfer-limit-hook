// Reads and instructions for a limited token.

import {
  fetchEncodedAccount,
  fetchEncodedAccounts,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  unwrapOption,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  decodeMint,
  decodeToken,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedWithTransferHookInstructionAsync,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  decodeConfig,
  decodeUsage,
  findConfigPda,
  getInitializeInstructionAsync,
  getOpenUsageInstruction,
  getSetLimitInstruction,
  TRANSFER_LIMIT_HOOK_PROGRAM_ADDRESS as HOOK,
} from "../generated/index.js";
import { retry, type AppRpc } from "./chain.js";

export const NEW_TOKEN_DECIMALS = 6;

export type LimitedToken = {
  mint: Address;
  decimals: number;
  supply: bigint;
  mintAuthority: Address | null;
  /** Can change the limit, and is exempt from it. */
  issuer: Address;
  limit: bigint;
  windowSecs: bigint;
};
export type TokenLookup = { kind: "limited"; token: LimitedToken } | { kind: "none"; reason: string };

export const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

export async function usageAddress(mint: Address, owner: Address): Promise<Address> {
  const encode = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["usage", encode.encode(mint), encode.encode(owner)] });
  return pda;
}

export async function loadToken(rpc: AppRpc, mint: Address): Promise<TokenLookup> {
  const [config] = await findConfigPda({ mint });
  const [mintAccount, configAccount] = await retry(() => fetchEncodedAccounts(rpc, [mint, config], { commitment: "confirmed" }));
  if (!mintAccount?.exists) return { kind: "none", reason: "No account exists at this address on this network." };
  if (mintAccount.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) return { kind: "none", reason: "This is not a Token-2022 token." };

  let data;
  try {
    data = decodeMint(mintAccount).data;
  } catch {
    return { kind: "none", reason: "This is a Token-2022 account, but not a token. Paste the token's mint address." };
  }
  const hook = (unwrapOption(data.extensions) ?? []).find((e) => e.__kind === "TransferHook");
  if (hook?.__kind !== "TransferHook" || hook.programId !== HOOK) return { kind: "none", reason: "This token does not use the transfer-limit hook." };
  if (!configAccount?.exists || configAccount.programAddress !== HOOK) return { kind: "none", reason: "This token points at the hook, but its limit was never set." };

  const c = decodeConfig(configAccount).data;
  return {
    kind: "limited",
    token: {
      mint,
      decimals: data.decimals,
      supply: data.supply,
      mintAuthority: unwrapOption(data.mintAuthority),
      issuer: c.authority,
      limit: c.limit,
      windowSecs: c.windowSecs,
    },
  };
}

export type Holder = {
  owner: Address;
  balance: bigint;
  /** null: no allowance account, so the hook refuses every transfer. */
  spent: { used: bigint; windowStart: bigint } | null;
  /** Chain time of this reading. The hook uses the chain's clock, not the browser's. */
  now: bigint;
};

export async function loadHolder(rpc: AppRpc, mint: Address, owner: Address): Promise<Holder> {
  const [tokenAddress, usage] = await Promise.all([ata(owner, mint), usageAddress(mint, owner)]);
  const [tokenAccount, usageAccount, clock] = await retry(() =>
    fetchEncodedAccounts(rpc, [tokenAddress, usage, SYSVAR_CLOCK_ADDRESS], { commitment: "confirmed" }),
  );
  if (!clock?.exists) throw new Error("The network did not return its clock.");
  return {
    owner,
    balance: tokenAccount?.exists ? decodeToken(tokenAccount).data.amount : 0n,
    spent:
      usageAccount?.exists && usageAccount.programAddress === HOOK
        ? (({ used, windowStart }) => ({ used, windowStart }))(decodeUsage(usageAccount).data)
        : null,
    now: getSysvarClockDecoder().decode(clock.data).unixTimestamp,
  };
}

/** One transaction: create the mint with the hook, then set its limit. */
export async function createTokenInstructions(rpc: AppRpc, issuer: TransactionSigner, limit: bigint, windowSecs: bigint) {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize([extension("TransferHook", { authority: issuer.address, programId: HOOK })]));
  const lamports = await retry(() => rpc.getMinimumBalanceForRentExemption(space).send());
  const instructions: Instruction[] = [
    getCreateAccountInstruction({ payer: issuer, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeTransferHookInstruction({ mint: mint.address, authority: issuer.address, programId: HOOK }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: NEW_TOKEN_DECIMALS, mintAuthority: issuer.address }),
    await getInitializeInstructionAsync({ authority: issuer, mint: mint.address, limit, windowSecs }),
  ];
  return { mint: mint.address, instructions };
}

const createAta = async (payer: TransactionSigner, owner: Address, mint: Address) =>
  getCreateAssociatedTokenIdempotentInstruction({ payer, ata: await ata(owner, mint), owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

/** Gives `owner` tokens, and an allowance account if they have none. */
export async function fundHolderInstructions(rpc: AppRpc, issuer: TransactionSigner, token: LimitedToken, owner: Address, amount: bigint) {
  const instructions: Instruction[] = [
    await createAta(issuer, owner, token.mint),
    getMintToCheckedInstruction({ mint: token.mint, token: await ata(owner, token.mint), mintAuthority: issuer, amount, decimals: token.decimals }),
  ];
  const usage = await usageAddress(token.mint, owner);
  const existing = await retry(() => fetchEncodedAccount(rpc, usage, { commitment: "confirmed" }));
  // The issuer is exempt, so it needs no allowance account.
  if (!existing.exists && owner !== token.issuer) instructions.push(await openUsageInstruction(issuer, token.mint, owner));
  return instructions;
}

export async function openUsageInstruction(payer: TransactionSigner, mint: Address, owner: Address): Promise<Instruction> {
  const [config] = await findConfigPda({ mint });
  return getOpenUsageInstruction({ payer, config, usage: await usageAddress(mint, owner), owner });
}

export async function setLimitInstruction(authority: TransactionSigner, mint: Address, limit: bigint, windowSecs: bigint): Promise<Instruction> {
  const [config] = await findConfigPda({ mint });
  return getSetLimitInstruction({ authority, config, limit, windowSecs });
}

/** Creates the recipient's token account if needed, then transfers through the hook. */
export async function transferInstructions(rpc: AppRpc, from: TransactionSigner, token: LimitedToken, to: Address, amount: bigint) {
  const transfer = await getTransferCheckedWithTransferHookInstructionAsync(
    { rpc },
    {
      source: await ata(from.address, token.mint),
      mint: token.mint,
      destination: await ata(to, token.mint),
      authority: from,
      amount,
      decimals: token.decimals,
    },
    { recipient: to },
  );
  return [await createAta(from, to, token.mint), transfer];
}
