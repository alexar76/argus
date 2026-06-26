import type { VerifiableArtifact } from "../verify/index.js";
import { toVerifyBundle, type ProvenanceEntry } from "../provenance/index.js";
import { toVerifiableArtifact, type FrugalProof } from "../frugalproof/index.js";
import type { ApprovalEntry, ChainSeal } from "../sealed/index.js";
import type { SignedAttestation } from "../attest/index.js";
import { toMandateArtifact, type MandateSeal } from "../mandate/index.js";
import { toSpendCertArtifact, type SpendCertSeal } from "../spendcert/index.js";
import { toSelfBondArtifact, type SelfBond } from "../selfbond/index.js";
import type { ToolDef } from "../types.js";

/**
 * ARGUS's "verifiable conscience" — the demand-side super-power the ecosystem enables.
 *
 * Every other agent asks you to TRUST it. ARGUS hands you a single bundle and dares you
 * to REFUTE it. This composes the proofs ARGUS already emits about a session into one
 * object that `verifyBundle` / `argus verify` re-checks OFFLINE (pure Ed25519 + SHA-256,
 * no network, no wallet):
 *
 *   • oracle-receipts  — which oracles it paid, each Ed25519-signed by the provider
 *   • frugalproof      — that it stayed frugal (cost digest, VDF/commit-anchored)
 *   • tool-pin         — the tools that ran are byte-identical to what was approved (WARDEN)
 *   • sealed-chain     — the tamper-evident consent chain (reorder/edit ⇒ brokenAt)
 *   • attestation      — the negative guarantees it kept (no_egress / within_budget / …)
 *
 * A third party who trusts neither ARGUS, the network, nor AICOM re-runs the bundle and
 * gets a pass/fail per claim. The awe is real because the math is — change one byte of any
 * proof and the verifier names the exact broken claim.
 */
export const CONSCIENCE_SCHEMA = "argus-conscience/v1";

export interface ConscienceInput {
  /** Mandate sealed at run start, before any discovery (task+budget+pinned-tools commitment). */
  mandate?: MandateSeal;
  /** Signed oracle-call receipts collected during the session (provenance trail). */
  provenance?: ProvenanceEntry[];
  /** The session's frugality proof (cost digest, optionally VDF/commit-anchored). */
  frugalProof?: FrugalProof;
  /** Cheapest-trustworthy-pick certificate(s) for subcontracted spend (argmin over candidates). */
  spendCert?: SpendCertSeal;
  /** Self-bond: frugality+conduct staked to ARGUS's mesh identity (declaration; enforcement hub-side). */
  selfBond?: SelfBond;
  /** The WARDEN-pinned tool-def set in force, with its canonical hash. */
  toolPin?: { tools: ToolDef[]; hash: string };
  /** The tamper-evident consent chain and (optionally) its Ed25519 head seal. */
  consentChain?: { chain: ApprovalEntry[]; seal?: ChainSeal };
  /** The signed negative attestation (claims that provably held this session). */
  attestation?: SignedAttestation;
}

export interface ConscienceBundle {
  schema: typeof CONSCIENCE_SCHEMA;
  artifacts: VerifiableArtifact[];
}

/**
 * Fold the available proofs into one `{ schema, artifacts }` bundle that `verifyBundle`
 * accepts. Every section is optional — a crypto-off / read-only session may carry only
 * a frugalproof and a consent chain — but whatever is present must re-verify.
 */
export function buildConscienceBundle(input: ConscienceInput): ConscienceBundle {
  const artifacts: VerifiableArtifact[] = [];

  if (input.mandate) {
    artifacts.push(toMandateArtifact(input.mandate));
  }
  if (input.provenance && input.provenance.length > 0) {
    artifacts.push(...toVerifyBundle(input.provenance));
  }
  if (input.frugalProof) {
    artifacts.push(toVerifiableArtifact(input.frugalProof));
  }
  if (input.spendCert) {
    artifacts.push(toSpendCertArtifact(input.spendCert));
  }
  if (input.selfBond) {
    artifacts.push(toSelfBondArtifact(input.selfBond));
  }
  if (input.toolPin) {
    artifacts.push({ type: "tool-pin", tools: input.toolPin.tools, hash: input.toolPin.hash, label: "approved tool-def set" });
  }
  if (input.consentChain) {
    artifacts.push({ type: "sealed-chain", chain: input.consentChain.chain, seal: input.consentChain.seal, label: "consent chain" });
  }
  if (input.attestation) {
    artifacts.push({ type: "attestation", attestation: input.attestation, label: "negative attestation" });
  }

  return { schema: CONSCIENCE_SCHEMA, artifacts };
}
