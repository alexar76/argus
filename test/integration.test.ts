import { describe, it, expect } from "vitest";
import { OracleClient, buildOracleTools } from "../src/economy/oracles.js";
import { AimarketConsumer } from "../src/economy/aimarket.js";
import { createLogger } from "../src/logger.js";

// Live ecosystem integration — hits real AICOM endpoints. Network-gated so CI/unit
// runs stay hermetic: enable with ARGUS_INTEGRATION=1.
const RUN = process.env.ARGUS_INTEGRATION === "1";
const suite = RUN ? describe : describe.skip;
const log = createLogger("it", "error");

suite("AICOM ecosystem integration (live network)", () => {
  it("oracle_random returns real Platon VRF from the oracle-family", async () => {
    const tools = buildOracleTools(new OracleClient("https://oracles.modelmarket.dev/family", log));
    const r = await tools.find((t) => t.def.name === "oracle_random")!.run({ bytes: 8 }, { log, approved: false });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/random_hex|proof|platon/i);
  }, 20_000);

  it("hub_discover returns a capability list from the live Hub", async () => {
    const c = new AimarketConsumer({
      hubUrl: "https://magic-ai-factory.com",
      walletKey: "0x" + "1".repeat(64), // unused by discover (native GET); satisfies the ctor
      affiliate: "argus",
      verifyTee: false,
      defaultDepositUsd: 1,
      token: "USDC",
      chain: "base",
      log,
    });
    const caps = await c.discover("run", 5, 5);
    expect(Array.isArray(caps)).toBe(true);
  }, 20_000);
});
