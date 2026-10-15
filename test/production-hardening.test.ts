import { describe, it, expect, afterEach } from "vitest";
import { egressPosture, hardenForProduction, productionMode } from "../src/config.js";
import type { ArgusConfig, WardenConfig } from "../src/config.js";

/**
 * ARGUS's defaults are tuned for a laptop, and two of them are the wrong answer on a
 * host running unattended with a funded wallet:
 *
 *   allowUnknownServers: true   — a first run that blocks every server the catalog
 *                                 lists is a first run nobody repeats; the same
 *                                 setting on a server bridges whatever the catalog
 *                                 happens to name into an agent that can spend.
 *   no egress allowlist         — meant NO GUARD at all, so the absence of a decision
 *                                 was the most permissive setting available.
 *
 * The rule that keeps this honest: production tightens only what argus.config.json
 * left unsaid. An operator who wrote a value meant it.
 */

const PROD = "AIFACTORY_PROD";

function cfg(warden: Partial<WardenConfig> = {}): ArgusConfig {
  return {
    warden: {
      blockAtSeverity: "high",
      sensitiveToolPatterns: [],
      allowUnknownServers: true,
      pinToolDefs: true,
      oracleFamilyUrl: "https://oracles.example/family",
      egressAllowlist: [],
      ...warden,
    },
  } as unknown as ArgusConfig;
}

describe("production hardening", () => {
  const saved = process.env[PROD];
  afterEach(() => {
    if (saved === undefined) delete process.env[PROD];
    else process.env[PROD] = saved;
  });
  const prod = (on: boolean) => {
    if (on) process.env[PROD] = "1";
    else delete process.env[PROD];
  };

  it("is off unless the ecosystem-wide marker says otherwise", () => {
    prod(false);
    expect(productionMode()).toBe(false);
    const c = cfg();
    expect(hardenForProduction(c, {})).toEqual([]);
    expect(c.warden.allowUnknownServers).toBe(true);
  });

  it("closes the origin gate when the config file is silent about it", () => {
    prod(true);
    const c = cfg();
    const applied = hardenForProduction(c, {});
    expect(c.warden.allowUnknownServers).toBe(false);
    expect(applied.join(" ")).toContain("allowUnknownServers=false");
  });

  it("does NOT reverse a value the operator wrote", () => {
    // Silently flipping this would be worse than the permissive default: discovery
    // would stop working and nothing would say why.
    prod(true);
    const c = cfg({ allowUnknownServers: true });
    expect(hardenForProduction(c, { allowUnknownServers: true })).toEqual([]);
    expect(c.warden.allowUnknownServers).toBe(true);
  });

  it("reports what it changed, so doctor can print it", () => {
    prod(true);
    expect(hardenForProduction(cfg(), {})).toHaveLength(1);
    // Already closed by the file → nothing to report, and no double-counting.
    expect(hardenForProduction(cfg({ allowUnknownServers: false }), {})).toEqual([]);
  });
});

describe("egress posture", () => {
  const saved = process.env[PROD];
  afterEach(() => {
    if (saved === undefined) delete process.env[PROD];
    else process.env[PROD] = saved;
  });

  it("no allowlist on a laptop leaves web_fetch open, as before", () => {
    delete process.env[PROD];
    expect(egressPosture(cfg()).gated).toBe(false);
  });

  it("no allowlist in production GATES with an empty list, not no guard", () => {
    // EgressGuard with an empty allowlist refuses everything and says why. The bug was
    // that no allowlist produced no guard at all.
    process.env[PROD] = "1";
    const posture = egressPosture(cfg());
    expect(posture.gated).toBe(true);
    expect(posture.allowlist).toEqual([]);
    expect(posture.label).toContain("ARGUS_EGRESS_ALLOWLIST");
  });

  it("an allowlist gates on a laptop too", () => {
    delete process.env[PROD];
    const posture = egressPosture(cfg({ egressAllowlist: ["api.example"] }));
    expect(posture.gated).toBe(true);
    expect(posture.allowlist).toEqual(["api.example"]);
  });

  it("`*` is how unrestricted is stated out loud, in production too", () => {
    // It must be handled here: EgressGuard treats a bare `*` as a hostname that
    // matches nothing, so passing it through would block everything and read as a
    // wildcard in the config.
    process.env[PROD] = "1";
    const posture = egressPosture(cfg({ egressAllowlist: ["*"] }));
    expect(posture.gated).toBe(false);
    expect(posture.label).toContain("UNRESTRICTED");
  });

  it("`*` alongside hosts still means unrestricted, and never leaks into the guard", () => {
    process.env[PROD] = "1";
    const posture = egressPosture(cfg({ egressAllowlist: ["api.example", " * "] }));
    expect(posture.gated).toBe(false);
    expect(posture.allowlist).not.toContain("*");
  });
});
