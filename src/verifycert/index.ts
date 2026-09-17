import { createHash } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";
import type { VerificationOutcome } from "../types.js";

/**
 * VerifyCert — the Pay-on-Verified paper trail for paid hires.
 *
 * When ARGUS buys with --verified, the hub HOLDS the channel debit until Metis
 * (POST /v1/verify) verdicts the delivered output: pass → captured, fail → refunded
 * with a signed rejection receipt. This seals every verdict envelope ARGUS observed
 * this run into one SHA-256 commitment, so the conscience bundle PERSISTS the hub's
 * envelopes (and rejection receipts) VERBATIM and a third party can confirm offline
 * that the recorded outcomes were fixed and unedited.
 *
 * HONEST SCOPE (do not overclaim): the commitment proves ARGUS's RECORD of the hub's
 * envelopes, not the verdicts themselves. Each embedded envelope carries the hub's own
 * Ed25519 signature and a Metis trace_id (resolvable at GET /v1/traces/{trace_id});
 * checking THAT signature needs the hub's key and is deliberately out of scope for the
 * offline verifier — dispute a verdict against the hub, not against this cert.
 */
export const VERIFY_CERT_SCHEMA = "argus-verifycert/v1";

/** One verified hire: the resolved verification outcome plus what was bought. */
export interface VerifiedHire extends VerificationOutcome {
  capabilityId: string;
  priceUsd: number;
}

export interface VerifyCertSeal {
  schema: typeof VERIFY_CERT_SCHEMA;
  hires: VerifiedHire[];
  canonical: string;
  commitment: string;
  sealedAt: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Fixed-decimal USD/score normalization so a non-JS re-checker reproduces byte-identical sha256. */
function num(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : (0).toFixed(6);
}

/**
 * Stable, line-oriented canonical — trivially recomputable cross-language. The hub's
 * envelope (and any rejection receipt) is embedded VERBATIM as single-line JSON —
 * JSON.stringify never emits raw newlines — so the seal persists the proof objects
 * themselves, not summaries of them.
 */
export function canonicalVerifyCert(hires: readonly VerifiedHire[], sealedAt: string): string {
  const lines: string[] = [VERIFY_CERT_SCHEMA, `sealedAt:${sealedAt}`, `hires:${hires.length}`];
  hires.forEach((h, i) => {
    lines.push(
      `#${i} capability:${h.capabilityId}`,
      `priceUsd:${num(h.priceUsd)}`,
      `status:${h.status}`,
      `verified:${h.verified == null ? "null" : h.verified}`,
      `verifyScore:${h.verifyScore == null ? "null" : num(h.verifyScore)}`,
      `traceId:${h.traceId ?? "-"}`,
      `nonce:${h.nonce ?? "-"}`,
      `envelope:${JSON.stringify(h.envelope ?? {})}`,
      `rejection:${h.rejectionReceipt ? JSON.stringify(h.rejectionReceipt) : "-"}`,
    );
  });
  return lines.join("\n");
}

/** Seal the verified hires into a SHA-256 commitment. Empty ⇒ a valid empty seal (no artifact emitted). */
export function sealVerifyCert(hires: readonly VerifiedHire[], sealedAt: string): VerifyCertSeal {
  const canonical = canonicalVerifyCert(hires, sealedAt);
  return { schema: VERIFY_CERT_SCHEMA, hires: [...hires], canonical, commitment: sha256Hex(canonical), sealedAt };
}

/** The offline-verifiable artifact for a conscience bundle (a SHA-256 commitment). */
export function toVerifyCertArtifact(seal: VerifyCertSeal): VerifiableArtifact {
  return { type: "commitment", preimage: seal.canonical, hash: seal.commitment, label: "verify-cert · pay-on-verified verdicts (hub envelopes embedded verbatim)" };
}

export function renderVerifyCertLine(seal: VerifyCertSeal): string {
  const n = seal.hires.length;
  const passed = seal.hires.filter((h) => h.status === "settled").length;
  const refunded = seal.hires.filter((h) => h.refunded).length;
  return `verify-cert · ${n} verified hire(s) · ${passed} passed ✓ · ${refunded} refunded · ${n - passed - refunded} pending/skipped`;
}
