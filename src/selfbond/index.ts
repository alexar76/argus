import { createHash } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";

/**
 * self-bond — ARGUS stakes its OWN honesty under the same court it judges others by.
 *
 * Before settling, ARGUS binds its frugality claim (FrugalProof cost digest), its conduct
 * claim (attestation), the authorized ceiling (mandate.budgetUsd) and its realized spend
 * to its wallet-derived mesh identity, with a declared bond and a self-scored verdict —
 * all under one SHA-256 commitment. A stranger re-derives it offline and confirms "THIS
 * identity staked THIS bond against THIS exact cost-digest + conduct + ceiling-vs-spend
 * verdict, unedited." It is an honest SELF-INDICTMENT: "I declared $ceiling, spent
 * $actual; by my published rule I owe penalty $Z and stake $bond on it."
 *
 * HONEST SCOPE (do not overclaim): this is a client-side DECLARATION + bind-to-identity,
 * NOT enforcement. The hub does NOT yet slash on cost-claim mismatch (it slashes only on
 * a signed ProofOfMisbehavior dispute) — so no funds move, no live stake protects a buyer,
 * and `enforced` is always false. The bond is bound by SHA-256, not a secp256k1 signature
 * (the wallet key only derives the address) — it proves "whoever assembled this bundle
 * committed to this address", not "the key-holder signed it". Real enforcement is the
 * hub follow-up (a cost-bond endpoint + slash-on-mismatch + federated attestation).
 */
export const SELF_BOND_SCHEMA = "argus-selfbond/v1";

export interface SelfBondInput {
  taskHash: string;
  agentId: string;
  evmAddress: string;
  chain: string;
  bondUsd: number;
  token: string;
  penaltyRate: number;
  bondedCeilingUsd: number;
  actualSpendUsd: number;
  frugalDigest: string;
  /** The attestation's exact signed canonical (hashed into the bond, not stored verbatim). */
  attestationCanonical: string;
  mandateCommitment: string;
  sealedAt: string;
}

export interface SelfBondVerdict {
  overspendUsd: number;
  penaltyUsd: number;
  verdict: "within-bond" | "self-slash";
}

export interface SelfBond extends SelfBondVerdict {
  schema: typeof SELF_BOND_SCHEMA;
  taskHash: string;
  agentId: string;
  evmAddress: string;
  chain: string;
  bondUsd: number;
  token: string;
  penaltyRate: number;
  bondedCeilingUsd: number;
  actualSpendUsd: number;
  frugalDigest: string;
  attestationCanonicalHash: string;
  mandateCommitment: string;
  /** ALWAYS false in this slice — enforcement is hub-side and not present. */
  enforced: false;
  sealedAt: string;
  canonical: string;
  commitment: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function num(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : (0).toFixed(6);
}
function clampNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Pure scalar verdict: overspend = max(0, actual − ceiling); penalty = min(bond, rate·overspend). */
export function computeVerdict(bondedCeilingUsd: number, actualSpendUsd: number, bondUsd: number, penaltyRate: number): SelfBondVerdict {
  const overspendUsd = clampNonNeg(actualSpendUsd - bondedCeilingUsd);
  const penaltyUsd = overspendUsd > 0 ? Math.min(clampNonNeg(bondUsd), clampNonNeg(penaltyRate) * overspendUsd) : 0;
  return { overspendUsd, penaltyUsd, verdict: overspendUsd > 0 ? "self-slash" : "within-bond" };
}

/** Fixed line-oriented canonical — every field present, recomputable cross-language. */
export function canonicalSelfBond(b: Omit<SelfBond, "canonical" | "commitment">): string {
  return [
    SELF_BOND_SCHEMA,
    `taskHash:${b.taskHash}`,
    `agentId:${b.agentId}`,
    `evmAddress:${b.evmAddress}`,
    `chain:${b.chain}`,
    `bondUsd:${num(b.bondUsd)}`,
    `token:${b.token}`,
    `penaltyRate:${num(b.penaltyRate)}`,
    `bondedCeilingUsd:${num(b.bondedCeilingUsd)}`,
    `actualSpendUsd:${num(b.actualSpendUsd)}`,
    `overspendUsd:${num(b.overspendUsd)}`,
    `penaltyUsd:${num(b.penaltyUsd)}`,
    `verdict:${b.verdict}`,
    `enforced:${b.enforced}`,
    `frugalDigest:${b.frugalDigest}`,
    `attestationCanonicalHash:${b.attestationCanonicalHash}`,
    `mandateCommitment:${b.mandateCommitment}`,
    `sealedAt:${b.sealedAt}`,
  ].join("\n");
}

/** Declare a self-bond: bind the cost/conduct claims to identity, score the verdict, commit. */
export function declareSelfBond(input: SelfBondInput): SelfBond {
  const verdict = computeVerdict(input.bondedCeilingUsd, input.actualSpendUsd, input.bondUsd, input.penaltyRate);
  const body: Omit<SelfBond, "canonical" | "commitment"> = {
    schema: SELF_BOND_SCHEMA,
    taskHash: input.taskHash,
    agentId: input.agentId,
    evmAddress: input.evmAddress,
    chain: input.chain,
    bondUsd: input.bondUsd,
    token: input.token,
    penaltyRate: input.penaltyRate,
    bondedCeilingUsd: input.bondedCeilingUsd,
    actualSpendUsd: input.actualSpendUsd,
    frugalDigest: input.frugalDigest,
    attestationCanonicalHash: sha256Hex(input.attestationCanonical),
    mandateCommitment: input.mandateCommitment,
    enforced: false,
    sealedAt: input.sealedAt,
    ...verdict,
  };
  const canonical = canonicalSelfBond(body);
  return { ...body, canonical, commitment: sha256Hex(canonical) };
}

/** The offline-verifiable artifact for a conscience bundle (a SHA-256 commitment). */
export function toSelfBondArtifact(bond: SelfBond): VerifiableArtifact {
  return {
    type: "commitment",
    preimage: bond.canonical,
    hash: bond.commitment,
    label: "self-bond · frugality+conduct staked to mesh identity (enforcement hub-side, not present)",
  };
}

export function renderSelfBondLine(bond: SelfBond): string {
  return `self-bond · ${bond.agentId} · ceiling $${num(bond.bondedCeilingUsd)} vs spend $${num(bond.actualSpendUsd)} → ${bond.verdict}` +
    (bond.verdict === "self-slash" ? ` (declared penalty $${num(bond.penaltyUsd)} on $${num(bond.bondUsd)} bond; enforcement hub-side)` : ` (within bond)`);
}
