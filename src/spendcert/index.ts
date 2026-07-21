import { createHash } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";

/**
 * SpendCert — a re-checkable "cheapest-trustworthy-pick" certificate.
 *
 * When ARGUS subcontracts work (subcontract_invoke), it discovers a candidate set,
 * keeps those at/above the trust floor and within budget, and pays the CHEAPEST. This
 * records that decision so a third party can confirm OFFLINE: "given THIS recorded
 * candidate set + THIS trust floor + THIS budget cap, the thing ARGUS paid for is the
 * price-argmin — they match." The sha256 commitment proves the table was fixed and
 * unedited; the argmin is hand-recomputable from the plaintext.
 *
 * HONEST SCOPE (do not overclaim): this is ARGMIN over the recorded set, NOT a
 * Fermat/Kantor LP-dual certificate (those are for multi-hop routing, which the
 * one-capability-per-call spend path does not do). It assumes the hub's returned set
 * was complete and its advertised prices honest — it proves the choice over what was
 * recorded, not global optimality, and not the settled price. Enforcement is hub-side.
 */
export const SPEND_CERT_SCHEMA = "argus-spendcert/v1";

export interface SpendCandidate {
  capabilityId: string;
  priceUsd: number;
  trustScore: number;
}

export interface SpendDecision {
  intent: string;
  candidates: SpendCandidate[];
  trustFloor: number;
  budgetCap: number;
  chosen: string;
  chosenPriceUsd: number;
}

export interface SpendCertSeal {
  schema: typeof SPEND_CERT_SCHEMA;
  decisions: SpendDecision[];
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
 * The SHARED selection rule — the SAME one subcontract_invoke uses, so the cert proves
 * the agent's actual decision (no divergent second selector). Mirrors the live code:
 * keep trustScore>=floor, price<=cap, then the cheapest (stable price-asc — preserving
 * the caller's pre-order, e.g. CI rank, on price ties). Returns undefined if none qualify.
 */
export function selectCheapestTrustworthy<T extends { priceUsd: number; trustScore?: number }>(
  candidates: readonly T[],
  trustFloor: number,
  budgetCap: number,
): T | undefined {
  return candidates
    .filter((c) => (c.trustScore ?? 0) >= trustFloor)
    .filter((c) => c.priceUsd <= budgetCap)
    .slice()
    .sort((a, b) => a.priceUsd - b.priceUsd)[0];
}

/** Candidates sorted into a canonical order (by capabilityId) so reordering can't change the hash. */
function canonicalCandidates(cands: readonly SpendCandidate[]): string {
  return [...cands]
    .map((c) => ({ capabilityId: String(c.capabilityId ?? ""), priceUsd: c.priceUsd, trustScore: c.trustScore ?? 0 }))
    .sort((a, b) => (a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0))
    .map((c) => `  cand:${c.capabilityId}|price:${num(c.priceUsd)}|trust:${num(c.trustScore)}`)
    .join("\n");
}

/** Stable, line-oriented canonical — trivially recomputable cross-language. */
export function canonicalSpendCert(decisions: readonly SpendDecision[], sealedAt: string): string {
  const lines: string[] = [SPEND_CERT_SCHEMA, `sealedAt:${sealedAt}`, `decisions:${decisions.length}`];
  decisions.forEach((d, i) => {
    lines.push(
      `#${i} intent:${sha256Hex(d.intent ?? "")}`,
      `trustFloor:${num(d.trustFloor)}`,
      `budgetCap:${num(d.budgetCap)}`,
      `chosen:${d.chosen}`,
      `chosenPriceUsd:${num(d.chosenPriceUsd)}`,
      canonicalCandidates(d.candidates),
    );
  });
  return lines.join("\n");
}

/** Seal the spend decisions into a SHA-256 commitment. Empty ⇒ a valid empty seal (no artifact emitted). */
export function sealSpendCert(decisions: readonly SpendDecision[], sealedAt: string): SpendCertSeal {
  const canonical = canonicalSpendCert(decisions, sealedAt);
  return { schema: SPEND_CERT_SCHEMA, decisions: [...decisions], canonical, commitment: sha256Hex(canonical), sealedAt };
}

/** The offline-verifiable artifact for a conscience bundle (a SHA-256 commitment). */
export function toSpendCertArtifact(seal: SpendCertSeal): VerifiableArtifact {
  return { type: "commitment", preimage: seal.canonical, hash: seal.commitment, label: "spend-cert · cheapest trustworthy pick (argmin over recorded candidates)" };
}

export function renderSpendCertLine(seal: SpendCertSeal): string {
  const n = seal.decisions.length;
  const spent = seal.decisions.reduce((s, d) => s + (Number.isFinite(d.chosenPriceUsd) ? d.chosenPriceUsd : 0), 0);
  return `spend-cert · ${n} subcontract pick(s) · $${spent.toFixed(6)} · cheapest-trustworthy, re-checkable`;
}
