import { describe, it, expect, afterEach } from "vitest";
import { cryptoEnvSetting } from "../src/config.js";

const KEYS = ["AIFACTORY_CRYPTO_ENABLED", "ARGUS_CRYPTO_ENABLED"] as const;

describe("crypto env contract (ecosystem-wide switch)", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  const clear = () => KEYS.forEach((k) => delete process.env[k]);

  it("defaults to undefined (→ off) when neither var is set", () => {
    clear();
    expect(cryptoEnvSetting()).toBeUndefined();
  });

  it("AIFACTORY_CRYPTO_ENABLED is authoritative over ARGUS_CRYPTO_ENABLED", () => {
    clear();
    process.env.AIFACTORY_CRYPTO_ENABLED = "1";
    process.env.ARGUS_CRYPTO_ENABLED = "0";
    expect(cryptoEnvSetting()).toBe(true);
    process.env.AIFACTORY_CRYPTO_ENABLED = "0";
    process.env.ARGUS_CRYPTO_ENABLED = "1";
    expect(cryptoEnvSetting()).toBe(false);
  });

  it("falls back to ARGUS_CRYPTO_ENABLED (back-compat) when the ecosystem var is unset", () => {
    clear();
    process.env.ARGUS_CRYPTO_ENABLED = "1";
    expect(cryptoEnvSetting()).toBe(true);
  });

  it("shares the Python truthy rule (1/true/yes/on)", () => {
    clear();
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      process.env.AIFACTORY_CRYPTO_ENABLED = v;
      expect(cryptoEnvSetting()).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.AIFACTORY_CRYPTO_ENABLED = v;
      expect(cryptoEnvSetting()).toBe(false);
    }
  });
});
