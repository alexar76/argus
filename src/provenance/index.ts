import type { VerifiableArtifact } from "../verify/index.js";

/**
 * Provenance — the trust trailer on an answer.
 *
 * Ideology: "show your work" for trust. When ARGUS-3 leans on a paid capability or
 * an oracle to produce an answer, you should be able to unfold *exactly whom it
 * trusted* — each provider, what it cost, and the verifiable artifact (signed
 * receipt / commitment) that lets you re-check the claim with `argus verify`.
 *
 * This is a pure READ-SIDE aggregation of artifacts the agent already collects in
 * its observe step (the structured `data` of each tool result). It runs no model
 * and adds ZERO reasoning tokens — honesty that is also frugal. With no external
 * calls the trailer simply states the answer was produced locally.
 */
export interface ProvenanceEntry {
  source: "oracle" | "hub";
  tool: string;
  capabilityId?: string;
  priceUsd?: number;
  /** LUMEN trust score of the provider at call time, when known. */
  trustScore?: number;
  /** A signed/committed artifact a third party can re-check with `argus verify`. */
  verifiable?: VerifiableArtifact;
  /**
   * What the HUB said about its own receipt — not a verification result.
   *
   * This is `tee_verified` taken verbatim out of the hub's invoke response. The TypeScript
   * SDK this wraps performs no receipt verification at all, so nothing independent has
   * looked at the signature. It used to be rendered as "✓ receipt valid (SDK)", which reads
   * as provenance and is the one thing it cannot be: the party being trusted is the party
   * making the claim. `verifiable` (i.e. `argus verify` over a real artifact) is the signal
   * that means something.
   */
  receiptValid?: boolean;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Derive a provenance entry from a tool's structured result, or null if the tool
 * made no external (oracle/hub) call worth recording.
 */
export function extractEntry(toolName: string, data: unknown): ProvenanceEntry | null {
  const d = asObj(data);
  if (!d) return null;
  const isOracle = toolName.startsWith("oracle_");
  const isHub = toolName.startsWith("hub_") || toolName.startsWith("subcontract");
  if (!isOracle && !isHub) return null;

  const receipt = asObj(d.receipt);
  const priceUsd =
    typeof d.priceUsd === "number" ? d.priceUsd : receipt && typeof receipt.price_usd === "number" ? (receipt.price_usd as number) : undefined;

  if (isOracle) {
    const capabilityId = receipt && typeof receipt.capability_id === "string" ? (receipt.capability_id as string) : undefined;
    const signerPublicKey = typeof d.signerPublicKey === "string" ? (d.signerPublicKey as string) : undefined;
    const verifiable: VerifiableArtifact | undefined =
      receipt && signerPublicKey ? { type: "oracle-receipt", receipt, signerPublicKey, label: `oracle ${capabilityId ?? toolName}` } : undefined;
    return { source: "oracle", tool: toolName, capabilityId, priceUsd, verifiable };
  }
  // hub_invoke: `receiptValid` is the HUB's own `tee_verified` flag, passed through. The
  // comment here used to say the SDK validates the receipt internally — it does not, and
  // believing that is what turned a self-report into a checkmark.
  const capabilityId = typeof d.capabilityId === "string" ? (d.capabilityId as string) : undefined;
  const receiptValid = typeof d.receiptValid === "boolean" ? (d.receiptValid as boolean) : undefined;
  const trustScore = typeof d.trustScore === "number" ? (d.trustScore as number) : undefined;
  return { source: "hub", tool: toolName, capabilityId, priceUsd, receiptValid, trustScore };
}

/** Accumulates provenance entries across a run (read-side, no model calls). */
export class ProvenanceCollector {
  private readonly entries: ProvenanceEntry[] = [];

  record(toolName: string, data: unknown): void {
    const e = extractEntry(toolName, data);
    if (e) this.entries.push(e);
  }

  list(): ProvenanceEntry[] {
    return [...this.entries];
  }

  get count(): number {
    return this.entries.length;
  }

  /** The verifiable artifacts, ready to hand to `argus verify`. */
  toBundle(): VerifiableArtifact[] {
    return toVerifyBundle(this.entries);
  }
}

/** The verifiable artifacts from a set of entries — the bundle `argus verify` checks. */
export function toVerifyBundle(entries: ProvenanceEntry[]): VerifiableArtifact[] {
  return entries.map((e) => e.verifiable).filter((v): v is VerifiableArtifact => Boolean(v));
}

/** Render the collapsible trust trailer for a CLI/Telegram/HTTP answer. */
export function renderTrailer(entries: ProvenanceEntry[]): string {
  if (entries.length === 0) {
    return "trust · answered locally — no external trust dependencies";
  }
  const lines = entries.map((e) => {
    const price = e.priceUsd != null ? `$${e.priceUsd}` : "free";
    const trust = e.trustScore != null ? ` · trust ${e.trustScore}` : "";
    // Only `verifiable` earns a ✓: it means an artifact was re-checked locally. A hub
    // saying its own receipt is fine is a claim, and is shown as one.
    const proof = e.verifiable
      ? "✓ verifiable (argus verify)"
      : e.receiptValid === true
        ? "· hub asserts receipt ok (unverified here)"
        : e.receiptValid === false
          ? "✕ hub reports receipt INVALID"
          : "· unverified (offline)";
    const who = e.capabilityId ?? e.tool;
    return `  • ${e.source}: ${who} — ${price}${trust} · ${proof}`;
  });
  const verifiable = entries.filter((e) => e.verifiable).length;
  const head = `trust · ${entries.length} external call(s), ${verifiable} re-verifiable`;
  return [head, ...lines].join("\n");
}
