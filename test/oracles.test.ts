import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveOracleInvokeBase } from "../src/economy/oracles.js";

const FAMILY = "https://oracles.modelmarket.dev/family";

describe("resolveOracleInvokeBase", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.ARGUS_ORACLE_PORTAL;
    delete process.env.ARGUS_ORACLE_FAMILY_URL;
    delete process.env.ARGUS_ORACLE_PLATON_URL;
    delete process.env.ARGUS_ORACLE_CHRONOS_URL;
  });

  afterEach(() => {
    process.env = env;
  });

  it("routes Platon to portal root", () => {
    expect(resolveOracleInvokeBase("platon.random@v1", FAMILY)).toBe("https://oracles.modelmarket.dev");
  });

  it("routes family oracles to /family", () => {
    expect(resolveOracleInvokeBase("lumen.reputation@v1", FAMILY)).toBe(FAMILY);
  });

  it("routes Chronos to /chronos", () => {
    expect(resolveOracleInvokeBase("chronos.eval@v1", FAMILY)).toBe("https://oracles.modelmarket.dev/chronos");
  });

  it("routes physics oracles to /{slug}", () => {
    expect(resolveOracleInvokeBase("fermat.route@v1", FAMILY)).toBe("https://oracles.modelmarket.dev/fermat");
  });
});
