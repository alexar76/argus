import { createHash } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";

/**
 * FrugalProof — a verifiable cost receipt for a single task.
 *
 * Ideology: ARGUS's pitch is "frugal AND auditable". A frugality claim that you
 * cannot re-check is just marketing. FrugalProof turns "this task cost $0.003 over
 * 4 steps" into an artifact: it pins the exact resource snapshot to the task it was
 * spent on (taskHash) and the model tier it ran on (modelTier) by hashing all three
 * into one canonical SHA-256 digest. Anyone can recompute that digest from the same
 * snapshot and confirm nothing was edited after the fact.
 *
 * The local digest is ALWAYS produced — no wallet, no network, no model tokens. If
 * an economy client is supplied, FrugalProof additionally tries to ANCHOR the digest
 * so a third party can re-check it without trusting ARGUS at all:
 *   - `platon.commit@v1` — a binding commitment of the digest (you can later reveal),
 *   - `chronos.eval@v1`  — a time-bound / VDF evaluation seeded by the digest.
 * Anchoring is strictly best-effort. ANY failure (offline, capability missing, a
 * client that throws) is caught and degrades to `mode:"local-snapshot"`,
 * `anchored:false`. buildFrugalProof NEVER throws — frugality reporting must not be
 * able to break the run it is reporting on.
 */

/** The raw resource snapshot for one task. All counters are non-negative. */
export interface CostSnapshot {
  tokensIn: number;
  tokensOut: number;
  steps: number;
  costUsd: number;
}

/** The minimal economy client FrugalProof needs — taken as a parameter, never imported. */
export interface FrugalClient {
  invoke(capabilityId: string, input: unknown, productId?: string): Promise<{ output: unknown }>;
}

export interface BuildFrugalProofInput {
  snapshot: CostSnapshot;
  /** Hash of the task this cost was spent on (binds the receipt to the work). */
  taskHash: string;
  /** Model tier the task ran on, e.g. "haiku" / "sonnet" / "local". */
  modelTier: string;
  /** Optional economy client; when present FrugalProof attempts to anchor the digest. */
  client?: FrugalClient | null;
}

/** A successful anchor against an oracle capability. */
export interface FrugalAnchor {
  capabilityId: string;
  output: unknown;
}

export type FrugalProofMode = "anchored" | "local-snapshot";

export interface FrugalProof {
  /** The normalized snapshot the digest was computed over. */
  snapshot: CostSnapshot;
  taskHash: string;
  modelTier: string;
  /** SHA-256 (hex) over the canonical snapshot+taskHash+modelTier string. ALWAYS present. */
  digest: string;
  /** The exact pre-image of `digest`, so a third party can recompute it. */
  canonical: string;
  /** True only when at least one anchor succeeded. */
  anchored: boolean;
  mode: FrugalProofMode;
  /** The platon commitment anchor, when it succeeded. */
  commit?: FrugalAnchor;
  /** The chronos time-bound (VDF) anchor, when it succeeded. */
  vdf?: FrugalAnchor;
  /** Human-readable note describing why anchoring did or did not happen. */
  note: string;
}

/** Capability id for the binding commitment anchor. */
export const PLATON_COMMIT_CAPABILITY = "platon.commit@v1";
/** Capability id for the time-bound / VDF anchor. */
export const CHRONOS_EVAL_CAPABILITY = "chronos.eval@v1";

/** Clamp a possibly-bad number to a finite, non-negative value (defends the digest). */
function clampNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Normalize a snapshot so the digest is stable regardless of float/NaN noise. */
export function normalizeSnapshot(s: CostSnapshot): CostSnapshot {
  return {
    tokensIn: Math.trunc(clampNonNeg(s.tokensIn)),
    tokensOut: Math.trunc(clampNonNeg(s.tokensOut)),
    steps: Math.trunc(clampNonNeg(s.steps)),
    // costUsd is a fraction of a cent at times; keep it as a clamped finite number.
    costUsd: clampNonNeg(s.costUsd),
  };
}

/**
 * Build the canonical pre-image string the digest hashes. Field order is FIXED and
 * documented so any language can reproduce it. Changing this is a breaking change.
 */
export function frugalCanonical(snapshot: CostSnapshot, taskHash: string, modelTier: string): string {
  const n = normalizeSnapshot(snapshot);
  return [
    "frugalproof:v1",
    `task_hash:${taskHash}`,
    `model_tier:${modelTier}`,
    `tokens_in:${n.tokensIn}`,
    `tokens_out:${n.tokensOut}`,
    `steps:${n.steps}`,
    `cost_usd:${n.costUsd}`,
  ].join("|");
}

/** SHA-256 (hex) of a UTF-8 string. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Build a FrugalProof for one task.
 *
 * Always returns a proof with a recomputable local `digest`. If `client` is given,
 * attempts to anchor the digest via platon (commit) and chronos (VDF); any failure
 * degrades gracefully to a local-only proof. NEVER throws.
 */
export async function buildFrugalProof(input: BuildFrugalProofInput): Promise<FrugalProof> {
  const snapshot = normalizeSnapshot(input.snapshot);
  const taskHash = input.taskHash;
  const modelTier = input.modelTier;
  const canonical = frugalCanonical(snapshot, taskHash, modelTier);
  const digest = sha256Hex(canonical);

  const base: FrugalProof = {
    snapshot,
    taskHash,
    modelTier,
    digest,
    canonical,
    anchored: false,
    mode: "local-snapshot",
    note: "local cost snapshot — no economy client supplied (offline / crypto-off)",
  };

  const client = input.client;
  if (!client) return base;

  // Best-effort anchoring. Each anchor is independent: one can succeed while the
  // other fails. The whole block is also wrapped so a throwing client can never
  // escape — frugality reporting must not break the run it reports on.
  let commit: FrugalAnchor | undefined;
  let vdf: FrugalAnchor | undefined;
  try {
    commit = await tryAnchor(client, PLATON_COMMIT_CAPABILITY, { value: digest });
  } catch {
    commit = undefined;
  }
  try {
    vdf = await tryAnchor(client, CHRONOS_EVAL_CAPABILITY, { seed: digest });
  } catch {
    vdf = undefined;
  }

  const anchored = Boolean(commit) || Boolean(vdf);
  if (!anchored) {
    return { ...base, note: "anchoring attempted but no oracle responded — degraded to local snapshot" };
  }

  const which = [commit ? "platon.commit" : null, vdf ? "chronos.eval" : null].filter(Boolean).join(" + ");
  return {
    ...base,
    anchored: true,
    mode: "anchored",
    ...(commit ? { commit } : {}),
    ...(vdf ? { vdf } : {}),
    note: `cost digest anchored via ${which}`,
  };
}

/** Invoke one anchor capability and normalize its result, or undefined on a falsy/empty output. */
async function tryAnchor(client: FrugalClient, capabilityId: string, payload: unknown): Promise<FrugalAnchor | undefined> {
  const productId = `prod-${capabilityId.split(".")[0] ?? capabilityId}`;
  const r = await client.invoke(capabilityId, payload, productId);
  const output = r?.output;
  if (output === undefined || output === null) return undefined;
  return { capabilityId, output };
}

/**
 * The verifiable artifact for `argus verify`: the cost digest is a commitment whose
 * pre-image is the canonical string. A third party recomputes SHA-256(canonical) and
 * confirms it equals `digest` — proving the snapshot was not edited after the fact.
 */
export function toVerifiableArtifact(proof: FrugalProof): VerifiableArtifact {
  return {
    type: "commitment",
    preimage: proof.canonical,
    hash: proof.digest,
    label: `frugal cost receipt (${proof.modelTier})`,
  };
}

/** A compact one-line summary suitable for a CLI/Telegram trailer. */
export function renderFrugalLine(proof: FrugalProof): string {
  const s = proof.snapshot;
  const cost = `$${s.costUsd}`;
  const anchor = proof.anchored ? "anchored ✓" : "local-only";
  return `frugal · ${cost} · ${s.tokensIn}+${s.tokensOut} tok · ${s.steps} step(s) · ${anchor} · ${proof.digest.slice(0, 12)}…`;
}
