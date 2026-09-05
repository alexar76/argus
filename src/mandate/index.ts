import { createHash } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";

/**
 * Seal-before-discover — ARGUS commits to its MANDATE (what it was authorized to do,
 * on whose terms) at the very START of a run, BEFORE any `hub_discover` can surface a
 * provider's pitch or price. No vendor can then re-aim the task mid-run, and the
 * conscience bundle carries a re-derivable proof the mandate was fixed before discovery.
 *
 * The offline-verifiable core is a SHA-256 commitment over a canonical mandate string
 * (task-hash + budget ceiling + the WARDEN-pinned tool-def hash). When `ARGUS_AESTUS_SEAL`
 * is set, the same canonical is also wrapped in an Aestus RSW time-lock as an extra,
 * online-checkable anchor (proof a minimum sequential-time elapsed) — but the commitment
 * is what `argus verify` re-checks with ZERO network. The mandate is not secret, so the
 * commitment (not Aestus's encryption) is the load-bearing claim.
 */
export const MANDATE_SCHEMA = "argus-mandate/v1";

/** Aestus RSW time-lock anchor (online-verifiable via aestus.open/aestus.verify). */
export interface AestusAnchor {
  scheme: string;
  N: string;
  a: string;
  T: number;
  key_commitment: string;
  modulus_bits?: number;
}

export interface MandateSeal {
  schema: typeof MANDATE_SCHEMA;
  /** sha256(task) — binds the task without revealing the prompt in the bundle. */
  taskHash: string;
  /** The per-task USD ceiling in force (budget governor). */
  budgetUsd: number;
  /** The WARDEN-pinned tool-def set hash at seal time. */
  toolsHash: string;
  sealedAt: string;
  canonical: string;
  commitment: string;
  aestus?: AestusAnchor;
}

export interface MandateInput {
  taskHash: string;
  budgetUsd: number;
  toolsHash: string;
  sealedAt: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Stable, line-oriented canonical — trivially recomputable cross-language. */
export function canonicalMandate(m: MandateInput): string {
  return [
    MANDATE_SCHEMA,
    `taskHash:${m.taskHash}`,
    `budgetUsd:${m.budgetUsd}`,
    `toolsHash:${m.toolsHash}`,
    `sealedAt:${m.sealedAt}`,
  ].join("\n");
}

/** Seal the mandate locally: a SHA-256 commitment, offline, zero-dependency. */
export function sealMandate(m: MandateInput): MandateSeal {
  const canonical = canonicalMandate(m);
  return {
    schema: MANDATE_SCHEMA,
    taskHash: m.taskHash,
    budgetUsd: m.budgetUsd,
    toolsHash: m.toolsHash,
    sealedAt: m.sealedAt,
    canonical,
    commitment: sha256Hex(canonical),
  };
}

/** Minimal oracle-invoke surface (matches economy/oracles `OracleClient.invoke`). */
export interface MandateOracleClient {
  invoke(capabilityId: string, input: unknown, productId?: string): Promise<{ output: unknown }>;
}

/**
 * Optional: wrap the sealed mandate's canonical in an Aestus RSW time-lock as an extra
 * anchor. GRACEFUL — on any failure (oracle unreachable, crypto-off) the seal is returned
 * unchanged, so the offline commitment always stands. Heavy (T sequential squarings at
 * seal time), hence opt-in via `ARGUS_AESTUS_SEAL`.
 */
export async function anchorWithAestus(
  seal: MandateSeal,
  client: MandateOracleClient,
  opts?: { T?: number },
): Promise<MandateSeal> {
  try {
    const T = Math.max(1, opts?.T ?? 50_000);
    const { output } = await client.invoke("aestus.seal@v1", { data: seal.canonical, T }, "prod-aestus");
    const o = (output ?? {}) as Record<string, unknown>;
    if (typeof o.N === "string" && typeof o.a === "string" && typeof o.key_commitment === "string") {
      return {
        ...seal,
        aestus: {
          scheme: String(o.scheme ?? "rsw-timelock/v1"),
          N: o.N,
          a: o.a,
          T: Number(o.T ?? T),
          key_commitment: o.key_commitment,
          modulus_bits: typeof o.modulus_bits === "number" ? o.modulus_bits : undefined,
        },
      };
    }
  } catch {
    /* graceful: the offline commitment stands without the time-lock anchor */
  }
  return seal;
}

/** The offline-verifiable artifact for a conscience bundle (a SHA-256 commitment). */
export function toMandateArtifact(seal: MandateSeal): VerifiableArtifact {
  return { type: "commitment", preimage: seal.canonical, hash: seal.commitment, label: "mandate · sealed before discovery" };
}
