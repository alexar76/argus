import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { appendApproval, sealChain, type ApprovalEntry } from "../src/sealed/index.js";
import { buildAttestation, type SessionSummary } from "../src/attest/index.js";
import { buildFrugalProof, type CostSnapshot } from "../src/frugalproof/index.js";
import { verifyBundle } from "../src/verify/index.js";
import { buildConscienceBundle, CONSCIENCE_SCHEMA } from "../src/conscience/index.js";

const SESSION: SessionSummary = {
  startedAt: "2026-06-26T10:00:00.000Z",
  endedAt: "2026-06-26T10:05:00.000Z",
  egressAttempts: 0,
  unauthorizedToolCalls: 0,
  ceilingExceeded: false,
  sensitiveApproved: [],
};
const SNAP: CostSnapshot = { tokensIn: 800, tokensOut: 210, steps: 3, costUsd: 0.0019 };

function rec(i: number) {
  return {
    tool: `wallet_transfer_${i}`,
    argsHash: "aa".repeat(32),
    toolsHash: "bb".repeat(32),
    timestamp: `2026-06-26T10:0${i}:00.000Z`,
  };
}
function consentChain(n: number): ApprovalEntry[] {
  let c: ApprovalEntry[] = [];
  for (let i = 0; i < n; i++) c = appendApproval(c, rec(i));
  return c;
}

describe("conscience — unified verifiable bundle", () => {
  it("assembles all proof types and re-verifies offline", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const chain = consentChain(3);
    const seal = sealChain(chain, privateKey, publicKey);
    const attestation = buildAttestation({ session: SESSION });
    const frugalProof = await buildFrugalProof({ snapshot: SNAP, taskHash: "cd".repeat(32), modelTier: "haiku" });

    const bundle = buildConscienceBundle({ frugalProof, consentChain: { chain, seal }, attestation });
    expect(bundle.schema).toBe(CONSCIENCE_SCHEMA);
    expect(bundle.artifacts.map((a) => a.type).sort()).toEqual(["attestation", "commitment", "sealed-chain"]);

    const report = verifyBundle(bundle);
    expect(report.ok).toBe(true);
    expect(report.claims.every((c) => c.ok)).toBe(true);
  });

  it("flags a reordered consent chain at the broken index", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const chain = consentChain(3);
    const seal = sealChain(chain, privateKey, publicKey);
    const tampered = [chain[0], chain[2], chain[1]]; // swap links 1 and 2
    const bundle = buildConscienceBundle({ consentChain: { chain: tampered, seal } });
    const report = verifyBundle(bundle);
    expect(report.ok).toBe(false);
    expect(report.claims.some((c) => c.type === "sealed-chain" && !c.ok && /broken at entry/.test(c.detail))).toBe(true);
  });

  it("flags a tampered attestation (claim added after signing)", () => {
    const att = buildAttestation({ session: { ...SESSION, egressAttempts: 2 } }); // no_egress will NOT hold
    const forged = { ...att, claims: ["no_egress", ...att.claims] as typeof att.claims };
    const bundle = buildConscienceBundle({ attestation: forged });
    const report = verifyBundle(bundle);
    expect(report.ok).toBe(false);
    expect(report.claims.some((c) => c.type === "attestation" && !c.ok)).toBe(true);
  });

  it("detects a flipped frugal-cost digest", async () => {
    const frugalProof = await buildFrugalProof({ snapshot: SNAP, taskHash: "ef".repeat(32), modelTier: "sonnet" });
    const forged = { ...frugalProof, digest: "00".repeat(32) };
    const bundle = buildConscienceBundle({ frugalProof: forged });
    const report = verifyBundle(bundle);
    expect(report.ok).toBe(false);
  });

  it("a valid consent chain with no head seal still verifies (crypto-off path)", () => {
    const chain = consentChain(2);
    const bundle = buildConscienceBundle({ consentChain: { chain } });
    const report = verifyBundle(bundle);
    expect(report.ok).toBe(true);
    expect(report.claims[0].detail).toMatch(/no head seal/);
  });
});
