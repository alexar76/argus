import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { canonicalToolsHash } from "../warden/pinning.js";
import type { ToolDef } from "../types.js";

/**
 * `argus verify` — the offline, dependency-free re-verifier.
 *
 * Ideology: ARGUS's whole pitch is "auditable, not marketing". That pitch is only
 * true if a *third party* — who does not trust ARGUS, the network, or even AICOM —
 * can independently re-check the proofs ARGUS attaches to its work. This module is
 * that checker. It does pure local cryptography (Ed25519 verify + SHA-256 recompute),
 * makes ZERO network calls, and needs no wallet — so it works in full crypto-off /
 * offline mode by construction. If a proof does not re-verify here, it was a claim,
 * not a proof.
 *
 * It deliberately verifies only what is EXACTLY recomputable cross-language:
 *  - Ed25519 signatures over a fixed canonical string (oracle-core receipts),
 *  - SHA-256 over an exact supplied pre-image (graph_commitment / input_hash),
 *  - the WARDEN canonical tool-def hash (recomputed natively).
 * It never asks you to trust a number it cannot re-derive.
 */

export type VerifiableArtifact =
  | { type: "oracle-receipt"; receipt: Record<string, unknown>; signerPublicKey: string; label?: string }
  | { type: "commitment"; preimage: string; hash: string; label?: string }
  | { type: "tool-pin"; tools: ToolDef[]; hash: string; label?: string };

export interface ClaimResult {
  type: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  claims: ClaimResult[];
}

/** Reconstruct the oracle-core 7-field receipt canonical (must match signing.py). */
export function receiptCanonical(r: Record<string, unknown>): string {
  const success = r.success === false ? 0 : 1;
  return [
    `nonce:${r.nonce ?? ""}`,
    `product_id:${r.product_id ?? ""}`,
    `capability_id:${r.capability_id ?? ""}`,
    `price_usd:${r.price_usd ?? 0}`,
    `timestamp:${r.timestamp ?? ""}`,
    `success:${success}`,
    `latency_ms:${r.latency_ms ?? 0}`,
  ].join("|");
}

/** Build an Ed25519 public key object from a raw 32-byte key (base64), via SPKI DER. */
function ed25519FromRaw(rawB64: string) {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Verify an Ed25519 signature (base64) over a UTF-8 canonical string. */
export function verifyEd25519(canonical: string, valueB64: string, pubKeyB64: string): boolean {
  try {
    return nodeVerify(null, Buffer.from(canonical, "utf8"), ed25519FromRaw(pubKeyB64), Buffer.from(valueB64, "base64"));
  } catch {
    return false;
  }
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Verify one artifact, producing one or more claim results. */
export function verifyArtifact(a: VerifiableArtifact): ClaimResult[] {
  switch (a.type) {
    case "oracle-receipt": {
      const r = a.receipt ?? {};
      const sig = (r.signature as Record<string, unknown>) ?? {};
      const value = typeof sig.value === "string" ? sig.value : "";
      const cid = String(r.capability_id ?? "?");
      const label = a.label ?? `oracle receipt ${cid}`;
      if (!value) return [{ type: a.type, label, ok: false, detail: "no signature on receipt" }];
      if (!a.signerPublicKey) return [{ type: a.type, label, ok: false, detail: "no signer public key supplied — cannot verify" }];
      const ok = verifyEd25519(receiptCanonical(r), value, a.signerPublicKey);
      return [{ type: a.type, label, ok, detail: ok ? `Ed25519 signature valid (${cid})` : "Ed25519 signature INVALID — receipt was forged or altered" }];
    }
    case "commitment": {
      const label = a.label ?? "commitment";
      const got = sha256Hex(a.preimage ?? "");
      const ok = got === a.hash;
      return [{ type: a.type, label, ok, detail: ok ? `sha256 matches (${got.slice(0, 12)}…)` : `sha256 MISMATCH (recomputed ${got.slice(0, 12)}… ≠ claimed ${String(a.hash).slice(0, 12)}…)` }];
    }
    case "tool-pin": {
      const label = a.label ?? "tool-def pin";
      const got = canonicalToolsHash(a.tools ?? []);
      const ok = got === a.hash;
      return [{ type: a.type, label, ok, detail: ok ? `tool-def hash matches (${got.slice(0, 12)}…)` : `tool-def hash MISMATCH — definitions differ from the pinned set` }];
    }
    default:
      return [{ type: (a as { type?: string }).type ?? "unknown", label: "unknown", ok: false, detail: "unknown artifact type — cannot verify" }];
  }
}

/** Verify a bundle: a single artifact, an array, or `{ artifacts: [...] }`. */
export function verifyBundle(input: unknown): VerifyReport {
  let arts: unknown[];
  if (Array.isArray(input)) arts = input;
  else if (input && typeof input === "object" && Array.isArray((input as { artifacts?: unknown[] }).artifacts)) {
    arts = (input as { artifacts: unknown[] }).artifacts;
  } else if (input && typeof input === "object" && "type" in (input as object)) {
    arts = [input];
  } else {
    return { ok: false, claims: [{ type: "bundle", label: "input", ok: false, detail: "no verifiable artifacts found (expected an artifact, an array, or { artifacts: [...] })" }] };
  }
  const claims = arts.flatMap((a) => verifyArtifact(a as VerifiableArtifact));
  return { ok: claims.length > 0 && claims.every((c) => c.ok), claims };
}
