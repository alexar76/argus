import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { canonicalToolsHash } from "../warden/pinning.js";
import { verifyApprovalChain, verifySealedChain, type ApprovalEntry, type ChainSeal } from "../sealed/index.js";
import { verifyAttestation, claimsMatchCanonical, type SignedAttestation } from "../attest/index.js";
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

/** Max preimage length to hash (SHA-256 OOM guard). */
const MAX_PREIMAGE_LEN = 4_194_304; // 4 MiB

/** Max tool definitions in a pin artifact. */
const MAX_PIN_TOOLS = 10_000;

/** Validate a base64 string — must be pure base64 (RFC 4648 §4 or §5) with
 *  optional padding. Rejects strings with non-base64 chars or empty input. */
function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/_-]*={0,2}$/.test(s) && s.length > 0;
}

export type VerifiableArtifact =
  | { type: "oracle-receipt"; receipt: Record<string, unknown>; signerPublicKey: string; label?: string }
  | { type: "commitment"; preimage: string; hash: string; label?: string }
  | { type: "tool-pin"; tools: ToolDef[]; hash: string; label?: string }
  | { type: "sealed-chain"; chain: ApprovalEntry[]; seal?: ChainSeal; label?: string }
  | { type: "attestation"; attestation: SignedAttestation; label?: string };

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
  if (!isValidBase64(rawB64)) throw new Error("ed25519 public key: malformed base64");
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Verify an Ed25519 signature (base64) over a UTF-8 canonical string. */
export function verifyEd25519(canonical: string, valueB64: string, pubKeyB64: string): boolean {
  if (!isValidBase64(valueB64)) return false;
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
      const preimage = String(a.preimage ?? "");
      // OOM guard: refuse to hash an unreasonably large preimage.
      if (preimage.length > MAX_PREIMAGE_LEN) {
        return [{ type: a.type, label, ok: false, detail: `preimage too large (${preimage.length}B exceeds ${MAX_PREIMAGE_LEN}B limit) — refused` }];
      }
      const got = sha256Hex(preimage);
      const ok = got === a.hash;
      return [{ type: a.type, label, ok, detail: ok ? `sha256 matches (${got.slice(0, 12)}…)` : `sha256 MISMATCH (recomputed ${got.slice(0, 12)}… ≠ claimed ${String(a.hash).slice(0, 12)}…)` }];
    }
    case "tool-pin": {
      const label = a.label ?? "tool-def pin";
      const tools = a.tools ?? [];
      if (!Array.isArray(tools) || tools.length > MAX_PIN_TOOLS) {
        return [{ type: a.type, label, ok: false, detail: `invalid tool list (${Array.isArray(tools) ? tools.length : "not an array"} tools) — refused` }];
      }
      const got = canonicalToolsHash(tools as ToolDef[]);
      const ok = got === a.hash;
      return [{ type: a.type, label, ok, detail: ok ? `tool-def hash matches (${got.slice(0, 12)}…)` : `tool-def hash MISMATCH — definitions differ from the pinned set` }];
    }
    case "sealed-chain": {
      const label = a.label ?? "consent chain";
      const chain = a.chain ?? [];
      const chk = verifyApprovalChain(chain);
      if (!chk.ok) {
        return [{ type: a.type, label, ok: false, detail: `consent chain broken at entry ${chk.brokenAt ?? "?"} — reordered, edited, or forged` }];
      }
      const n = chain.length;
      const links = `${n} link${n === 1 ? "" : "s"}`;
      if (a.seal) {
        const sealOk = verifySealedChain(chain, a.seal);
        return [{ type: a.type, label, ok: sealOk, detail: sealOk ? `consent chain intact (${links}) + Ed25519 head seal valid` : "chain re-derives but the Ed25519 head seal is INVALID — head re-signed or swapped" }];
      }
      return [{ type: a.type, label, ok: true, detail: `consent chain intact (${links}); no head seal supplied` }];
    }
    case "attestation": {
      const label = a.label ?? "negative attestation";
      const att = a.attestation;
      if (!att) return [{ type: a.type, label, ok: false, detail: "no attestation supplied" }];
      const sigOk = verifyAttestation(att);
      const matchOk = claimsMatchCanonical(att);
      const ok = sigOk && matchOk;
      const detail = ok
        ? `Ed25519 attestation valid — claims held: ${att.claims.join(", ") || "(none)"}`
        : !sigOk
          ? "Ed25519 attestation signature INVALID — forged or altered"
          : "attestation claims do not match its signed canonical — tampered";
      return [{ type: a.type, label, ok, detail }];
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
