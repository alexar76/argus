import { describe, it, expect } from "vitest";
import {
  canonicalVerifyCert,
  sealVerifyCert,
  toVerifyCertArtifact,
  renderVerifyCertLine,
  VERIFY_CERT_SCHEMA,
  type VerifiedHire,
} from "../src/verifycert/index.js";
import { verifyBundle } from "../src/verify/index.js";
import { buildConscienceBundle } from "../src/conscience/index.js";

const AT = "2026-07-14T10:00:00.000Z";

function hire(over: Partial<VerifiedHire> = {}): VerifiedHire {
  return {
    capabilityId: "cap.translate@v1",
    priceUsd: 0.1,
    status: "settled",
    verified: true,
    verifyScore: 0.91,
    traceId: "tr_1",
    refunded: false,
    nonce: "rcpt_1",
    envelope: {
      requested: true,
      status: "settled",
      performed: true,
      verified: true,
      verify_score: 0.91,
      threshold: 0.7,
      trace_id: "tr_1",
      verifier: "metis.verify@v1",
      mode: "fast",
      settled: true,
      signature: { algorithm: "ed25519", value: "c2ln" },
    },
    ...over,
  };
}

function refundedHire(): VerifiedHire {
  return hire({
    status: "refunded",
    verified: false,
    verifyScore: 0.35,
    refunded: true,
    envelope: { requested: true, status: "refunded", verified: false, verify_score: 0.35, trace_id: "tr_1" },
    rejectionReceipt: { type: "verification_rejection", nonce: "vfail_1", refunded: true, verify_score: 0.35 },
  });
}

describe("verifycert — pay-on-verified verdict seal", () => {
  it("seals to sha256(canonical) and re-verifies offline; a tampered commitment fails", () => {
    const seal = sealVerifyCert([hire()], AT);
    expect(seal.schema).toBe(VERIFY_CERT_SCHEMA);
    expect(seal.canonical).toBe(canonicalVerifyCert([hire()], AT));
    expect(verifyBundle([toVerifyCertArtifact(seal)]).ok).toBe(true);
    expect(verifyBundle([{ ...toVerifyCertArtifact(seal), hash: "00".repeat(32) }]).ok).toBe(false);
  });

  it("PERSISTS the hub envelope and rejection receipt verbatim inside the preimage", () => {
    const h = refundedHire();
    const seal = sealVerifyCert([h], AT);
    // The commitment preimage carries the proof objects themselves, not summaries.
    expect(seal.canonical).toContain(`envelope:${JSON.stringify(h.envelope)}`);
    expect(seal.canonical).toContain(`rejection:${JSON.stringify(h.rejectionReceipt)}`);
    expect(seal.canonical).toContain("trace_id");
  });

  it("you cannot swap a verdict without breaking the hash", () => {
    const settled = sealVerifyCert([hire()], AT);
    const refunded = sealVerifyCert([refundedHire()], AT);
    expect(settled.commitment).not.toBe(refunded.commitment);
  });

  it("buildConscienceBundle adds exactly one verify-cert artifact and still verifies", () => {
    const bundle = buildConscienceBundle({ verifyCert: sealVerifyCert([hire(), refundedHire()], AT) });
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]!.type).toBe("commitment");
    expect(verifyBundle(bundle).ok).toBe(true);
  });

  it("graceful: empty hires seal without throwing; NaN scores normalize; render counts outcomes", () => {
    expect(() => sealVerifyCert([], AT)).not.toThrow();
    const nan = sealVerifyCert([hire({ verifyScore: Number.NaN })], AT);
    expect(nan.canonical).toContain("verifyScore:0.000000");
    const pending = hire({ status: "pending", verified: null, verifyScore: null, traceId: null });
    expect(sealVerifyCert([pending], AT).canonical).toContain("verified:null");
    const line = renderVerifyCertLine(sealVerifyCert([hire(), refundedHire(), pending], AT));
    expect(line).toContain("3 verified hire(s)");
    expect(line).toContain("1 passed ✓");
    expect(line).toContain("1 refunded");
  });
});
