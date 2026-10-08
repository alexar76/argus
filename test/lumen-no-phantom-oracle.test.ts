/**
 * Regression guard for the removed reputation gate — oracle side.
 *
 * That gate called the LUMEN oracle without ever supplying trust edges, so the
 * oracle returned its neutral default *before* making a request, and the gate
 * then told the user "LUMEN trust oracle unreachable". Nothing had been tried.
 * These tests hold LumenOracle to the distinction: "never asked" and "asked and
 * failed" are different answers.
 *
 * The gate-chain half of the guard travels with the gates, in
 * `@aimarket/warden`'s `test/no-phantom-gate.test.ts` — it asserts that vetting
 * a server opens no socket and that no gate taxes the score for a measurement
 * it never took.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { LumenOracle } from "../src/economy/lumen.js";
import { createLogger } from "../src/logger.js";

const silent = createLogger("t", "error");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LumenOracle separates 'never asked' from 'asked and failed'", () => {
  const unreachable = "http://127.0.0.1:1/family";

  it("returns no-graph-data without contacting the oracle when no edges are supplied", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const oracle = new LumenOracle({ oracleFamilyUrl: unreachable, log: silent, timeoutMs: 100 });

    const result = await oracle.scoreEntity("server-a");

    expect(spy).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    if (result.degraded) {
      expect(result.reason).toBe("no-graph-data");
      expect(result.detail).toMatch(/not contacted/);
    }
  });

  it("returns oracle-error only after a request was actually attempted", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const oracle = new LumenOracle({ oracleFamilyUrl: unreachable, log: silent, timeoutMs: 500 });

    const result = await oracle.scoreEntity("server-a", [[1, 0, 1]]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
    if (result.degraded) expect(result.reason).toBe("oracle-error");
  });
});
