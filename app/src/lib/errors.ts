// Turns a failed simulation or transaction into something a person can act on.
//
// The hook runs as a CPI inside Token-2022, so the failing top-level instruction
// belongs to Token-2022 and the generated `isTransferLimitHookError` (which
// compares that instruction's program) does not match. The logs name the program
// that really failed. Generated messages are also stripped from production builds.

import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  TRANSFER_LIMIT_HOOK_ERROR__INVALID_CONFIG,
  TRANSFER_LIMIT_HOOK_ERROR__LIMIT_EXCEEDED,
  TRANSFER_LIMIT_HOOK_ERROR__NOT_MINT_AUTHORITY,
  TRANSFER_LIMIT_HOOK_ERROR__NOT_TRANSFERRING,
  TRANSFER_LIMIT_HOOK_ERROR__UNAUTHORIZED,
  TRANSFER_LIMIT_HOOK_ERROR__USAGE_NOT_OPENED,
  TRANSFER_LIMIT_HOOK_PROGRAM_ADDRESS,
} from "../generated/index.js";

const HOOK_ERRORS: Record<number, string> = {
  [TRANSFER_LIMIT_HOOK_ERROR__LIMIT_EXCEEDED]: "The hook refused this transfer: it goes over the wallet's limit for the current window.",
  [TRANSFER_LIMIT_HOOK_ERROR__USAGE_NOT_OPENED]: "This wallet has no allowance account yet. Open one, then send again.",
  [TRANSFER_LIMIT_HOOK_ERROR__NOT_TRANSFERRING]: "The hook can only run inside a Token-2022 transfer.",
  [TRANSFER_LIMIT_HOOK_ERROR__NOT_MINT_AUTHORITY]: "Only the token's mint authority can set this up.",
  [TRANSFER_LIMIT_HOOK_ERROR__UNAUTHORIZED]: "Only the issuer can change the limit.",
  [TRANSFER_LIMIT_HOOK_ERROR__INVALID_CONFIG]: "The limit and the window must both be more than zero.",
};
const TOKEN_ERRORS: Record<number, string> = { 1: "The wallet does not hold enough tokens for this transfer." };

export type Failure = { message: string; hookCode: number | null };

export function explain(logs: readonly string[], err: unknown): Failure {
  // The innermost program to fail logs first; callers repeat the same code after it.
  for (const line of logs) {
    const m = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)$/.exec(line);
    if (!m) continue;
    const code = parseInt(m[2]!, 16);
    if (m[1] === TRANSFER_LIMIT_HOOK_PROGRAM_ADDRESS && HOOK_ERRORS[code]) return { message: HOOK_ERRORS[code], hookCode: code };
    if (m[1] === TOKEN_2022_PROGRAM_ADDRESS && TOKEN_ERRORS[code]) return { message: TOKEN_ERRORS[code], hookCode: null };
    break;
  }
  const raw = stringify(err);
  if (logs.some((l) => l.includes("insufficient lamports")) || /AccountNotFound|InsufficientFundsForFee|InsufficientFundsForRent/.test(raw)) {
    return { message: "The wallet needs more SOL for fees and rent.", hookCode: null };
  }
  return { message: `The transaction failed: ${raw}`, hookCode: null };
}

const stringify = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class TransactionFailed extends Error {
  constructor(readonly failure: Failure, readonly sent: boolean) {
    super(failure.message);
  }
}
