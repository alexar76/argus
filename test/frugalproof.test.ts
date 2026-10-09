import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildFrugalProof,
  frugalCanonical,
  normalizeSnapshot,
  toVerifiableArtifact,
  renderFrugalLine,
  PLATON_COMMIT_CAPABILITY,
  CHRONOS_EVAL_CAPABILITY,
  type FrugalClient,
  type CostSnapshot,
} from "../src/frugalproof/index.js";
import { verifyArtifact } from "../src/verify/index.js";

const SNAP: CostSnapshot = { tokensIn: 1200, tokensOut: 340, steps: 4, costUsd: 0.0031 };
const TASK_HASH = "ab".repeat(32);
const TIER = "haiku";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** A fake client that records every invoke and returns canned anchor outputs. */
function fakeClient(): FrugalClient & { calls: Array<{ cap: string; input: unknown; product?: string }> } {
  const calls: Array<{ cap: string; input: unknown; product?: string }> = [];
  return {
    calls,
    async invoke(cap: string, input: unknown, product?: string) {
      calls.push({ cap, input, product });
      if (cap === PLATON_COMMIT_CAPABILITY) return { output: { commitment: "0xcommit", index: 7 } };
      if (cap === CHRONOS_EVAL_CAPABILITY) return { output: { vdf: "0xvdf", iterations: 1000 } };
      return { output: null };
    },
  };
}

describe("frugalproof — canonical + digest", () => {
  it("produces a stable, recomputable digest", async () => {
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER });
    const expectedCanonical = frugalCanonical(SNAP, TASK_HASH, TIER);
    expect(proof.canonical).toBe(expectedCanonical);
    expect(proof.digest).toBe(sha256Hex(expectedCanonical));
    // A third party recomputing from the same inputs gets the same digest.
    expect(sha256Hex(frugalCanonical(SNAP, TASK_HASH, TIER))).toBe(proof.digest);
  });

  it("binds snapshot + taskHash + modelTier (changing any one changes the digest)", async () => {
    const base = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER });
    const diffTask = await buildFrugalProof({ snapshot: SNAP, taskHash: "ff".repeat(32), modelTier: TIER });
    const diffTier = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: "sonnet" });
    const diffSnap = await buildFrugalProof({ snapshot: { ...SNAP, steps: 5 }, taskHash: TASK_HASH, modelTier: TIER });
    expect(diffTask.digest).not.toBe(base.digest);
    expect(diffTier.digest).not.toBe(base.digest);
    expect(diffSnap.digest).not.toBe(base.digest);
  });

  it("normalizes NaN/negative/float counters defensively", () => {
    const dirty: CostSnapshot = { tokensIn: -5, tokensOut: Number.NaN, steps: 4.9, costUsd: Number.POSITIVE_INFINITY };
    const n = normalizeSnapshot(dirty);
    expect(n).toEqual({ tokensIn: 0, tokensOut: 0, steps: 4, costUsd: 0 });
  });
});

describe("frugalproof — anchoring", () => {
  it("anchors via platon + chronos when a client returns outputs", async () => {
    const client = fakeClient();
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER, client });
    expect(proof.anchored).toBe(true);
    expect(proof.mode).toBe("anchored");
    expect(proof.commit?.capabilityId).toBe(PLATON_COMMIT_CAPABILITY);
    expect(proof.commit?.output).toEqual({ commitment: "0xcommit", index: 7 });
    expect(proof.vdf?.capabilityId).toBe(CHRONOS_EVAL_CAPABILITY);
    expect(proof.vdf?.output).toEqual({ vdf: "0xvdf", iterations: 1000 });
    // The digest is what gets committed/seeded.
    const commitCall = client.calls.find((c) => c.cap === PLATON_COMMIT_CAPABILITY);
    const vdfCall = client.calls.find((c) => c.cap === CHRONOS_EVAL_CAPABILITY);
    expect(commitCall?.input).toEqual({ value: proof.digest });
    expect(vdfCall?.input).toEqual({ seed: proof.digest });
    // Local digest is still present and correct even when anchored.
    expect(proof.digest).toBe(sha256Hex(proof.canonical));
  });

  it("degrades to local-snapshot when client=null (still returns the local digest)", async () => {
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER, client: null });
    expect(proof.anchored).toBe(false);
    expect(proof.mode).toBe("local-snapshot");
    expect(proof.commit).toBeUndefined();
    expect(proof.vdf).toBeUndefined();
    expect(proof.digest).toBe(sha256Hex(proof.canonical));
  });

  it("treats a missing client (undefined) the same as offline", async () => {
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER });
    expect(proof.anchored).toBe(false);
    expect(proof.mode).toBe("local-snapshot");
    expect(proof.digest).toHaveLength(64);
  });

  it("does NOT throw when the client throws — degrades gracefully", async () => {
    const boom: FrugalClient = {
      async invoke() {
        throw new Error("network down");
      },
    };
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER, client: boom });
    expect(proof.anchored).toBe(false);
    expect(proof.mode).toBe("local-snapshot");
    expect(proof.digest).toBe(sha256Hex(proof.canonical));
    expect(proof.note).toMatch(/local snapshot/i);
  });

  it("anchors partially when only one capability responds", async () => {
    const onlyPlaton: FrugalClient = {
      async invoke(cap: string) {
        if (cap === PLATON_COMMIT_CAPABILITY) return { output: { commitment: "0xok" } };
        throw new Error("chronos offline");
      },
    };
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER, client: onlyPlaton });
    expect(proof.anchored).toBe(true);
    expect(proof.mode).toBe("anchored");
    expect(proof.commit).toBeDefined();
    expect(proof.vdf).toBeUndefined();
    expect(proof.note).toContain("platon.commit");
  });

  it("treats an empty (null/undefined) anchor output as not-anchored", async () => {
    const empties: FrugalClient = {
      async invoke() {
        return { output: null };
      },
    };
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER, client: empties });
    expect(proof.anchored).toBe(false);
    expect(proof.mode).toBe("local-snapshot");
    expect(proof.note).toMatch(/no oracle responded/i);
  });
});

describe("frugalproof — verifiable artifact (argus verify interop)", () => {
  it("emits a commitment artifact that re-verifies offline", async () => {
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER });
    const art = toVerifiableArtifact(proof);
    expect(art.type).toBe("commitment");
    const [claim] = verifyArtifact(art);
    expect(claim?.ok).toBe(true);
  });

  it("tamper-fails: editing the cost after the fact breaks re-verification", async () => {
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER });
    const art = toVerifiableArtifact(proof);
    // Forge a cheaper cost in the pre-image while keeping the original digest.
    const forged = { ...art, preimage: art.preimage.replace(/cost_usd:[\d.]+/, "cost_usd:0") } as typeof art;
    const [claim] = verifyArtifact(forged);
    expect(claim?.ok).toBe(false);
  });
});

describe("frugalproof — rendering", () => {
  it("renders a compact one-line summary", async () => {
    const proof = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER });
    const line = renderFrugalLine(proof);
    expect(line).toContain("frugal");
    expect(line).toContain("$0.0031");
    expect(line).toContain("local-only");
    const anchored = await buildFrugalProof({ snapshot: SNAP, taskHash: TASK_HASH, modelTier: TIER, client: fakeClient() });
    expect(renderFrugalLine(anchored)).toContain("anchored ✓");
  });
});
