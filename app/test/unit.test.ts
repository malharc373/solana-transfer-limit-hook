import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, test } from "vitest";
import { TRANSFER_LIMIT_HOOK_PROGRAM_ADDRESS as HOOK } from "../src/generated/index.js";
import { formatAmount, parseAmount } from "../src/lib/amount.js";
import { clusterOf } from "../src/lib/chain.js";
import { explain } from "../src/lib/errors.js";
import { allowance, formatDuration, splitWindow, UNITS } from "../src/lib/window.js";

describe("allowance mirrors the program's window rule", () => {
  const rule = { limit: 100n, windowSecs: 60n };
  test("inside the window", () => {
    expect(allowance(rule, { used: 60n, windowStart: 1000n }, 1010n)).toEqual({ used: 60n, remaining: 40n, resetsIn: 50n });
  });
  test("one second before and exactly at the boundary", () => {
    expect(allowance(rule, { used: 60n, windowStart: 1000n }, 1059n).resetsIn).toBe(1n);
    expect(allowance(rule, { used: 60n, windowStart: 1000n }, 1060n)).toEqual({ used: 0n, remaining: 100n, resetsIn: null });
  });
  test("a new allowance account (window_start 0) has the full limit", () => {
    expect(allowance(rule, { used: 0n, windowStart: 0n }, 1_795_000_000n).remaining).toBe(100n);
  });
  test("a limit lowered below what was sent leaves nothing, never a negative", () => {
    expect(allowance({ limit: 50n, windowSecs: 60n }, { used: 60n, windowStart: 0n }, 1n).remaining).toBe(0n);
  });
});

describe("amounts", () => {
  test("parses exactly, without floats", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount("9007199254.740993", 6)).toBe(9_007_199_254_740_993n); // not representable as a double
    expect(parseAmount("1,000", 6)).toBe(1_000_000_000n);
    expect(parseAmount(".5", 6)).toBe(500_000n);
    expect(parseAmount("7", 0)).toBe(7n);
  });
  test("rejects what the program could not take", () => {
    for (const bad of ["", " ", "0", "0.0", "-1", "1e3", "abc", "1.2.3", ".", "0.0000001", "18446744073709.551616"]) {
      expect(parseAmount(bad, 6), bad).toBeNull();
    }
  });
  test("formats", () => {
    expect(formatAmount(1_234_567_890_000n, 6)).toBe("1,234,567.89");
    expect(formatAmount(1n, 6)).toBe("0.000001");
    expect(formatAmount(0n, 6)).toBe("0");
    expect(formatAmount(1234n, 0)).toBe("1,234");
  });
});

test("durations", () => {
  expect([5n, 60n, 90n, 3600n, 5400n, 86_400n, 90_000n].map(formatDuration)).toEqual(["5 s", "1 min", "1 min 30 s", "1 h", "1 h 30 min", "1 d", "1 d 1 h"]);
});

test("splitting a window into a unit is exact", () => {
  expect(splitWindow(7200n)).toEqual({ count: 2n, unit: "hours" });
  expect(splitWindow(90n)).toEqual({ count: 90n, unit: "seconds" });
  for (const s of [1n, 60n, 61n, 3600n, 86_400n, 90_000n]) {
    const { count, unit } = splitWindow(s);
    expect(count * UNITS[unit]).toBe(s);
  }
});

describe("explain", () => {
  test("finds the hook's error under Token-2022's copy of the code", () => {
    const f = explain([`Program ${HOOK} failed: custom program error: 0x1770`, `Program ${TOKEN_2022_PROGRAM_ADDRESS} failed: custom program error: 0x1770`], {});
    expect(f.hookCode).toBe(6000);
    expect(f.message).toMatch(/over the wallet's limit/);
  });
  test("does not credit the hook with another program's code", () => {
    const other = "11111111111111111111111111111111";
    expect(explain([`Program ${other} failed: custom program error: 0x1770`], "x").hookCode).toBeNull();
  });
  test("ignores a log message that imitates a failure line", () => {
    expect(explain([`Program log: Program ${HOOK} failed: custom program error: 0x1770`], "x").hookCode).toBeNull();
  });
  test("token balance and SOL problems", () => {
    expect(explain([`Program ${TOKEN_2022_PROGRAM_ADDRESS} failed: custom program error: 0x1`], {}).message).toMatch(/enough tokens/);
    expect(explain([], "AccountNotFound").message).toMatch(/more SOL/);
    expect(explain([], { InstructionError: [0, { Custom: 7n }] }).message).toContain('"Custom":"7"');
  });
});

test("clusters", () => {
  expect(clusterOf("http://127.0.0.1:8899")).toBe("localnet");
  expect(clusterOf("https://api.devnet.solana.com")).toBe("devnet");
  expect(clusterOf("https://rpc.example.com/?x=devnet")).toBe("unknown");
});
