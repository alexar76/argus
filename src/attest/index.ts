import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";

/**
 * `argus attest` — the negative attestation core: prove something NEVER happened.
 *
 * Ideology: ARGUS's headline proofs (`argus verify`, provenance) are proof-of-ACTION
 * — "here is a signed receipt that this paid call occurred". This module is the
 * inversion: proof-of-NON-action. After a session it emits an Ed25519-signed
 * statement of what the agent structurally did NOT do — "no egress was attempted",
 * "no unauthorized tool was called", "no budget ceiling was breached". A cloud agent
 * cannot honestly give this: it has no audited boundary to attest about. ARGUS, which
 * runs every tool through WARDEN and a budget governor on a machine you control, can.
 *
 * The core is pure crypto + canonicalization. It makes ZERO network calls and needs
 * no wallet, so it works in full crypto-off / offline mode by construction. The
 * counters it attests over (egress attempts, unauthorized tool calls, ceiling
 * breaches, approved-sensitive list) are PARAMETERS — the caller's session governor
 * supplies them — so the core is testable in isolation and can never invent a
 * guarantee it was not handed.
 */

/** A single negative guarantee the agent is willing to sign over. */
export type AttestationClaim = "no_egress" | "no_unauthorized_tool" | "within_budget";

/** All claims that exist, in canonical (stable) order. */
export const ALL_CLAIMS: readonly AttestationClaim[] = ["no_egress", "no_unauthorized_tool", "within_budget"] as const;

/** Human-readable rationale for each claim, for rendering / docs. */
export const CLAIM_MEANING: Readonly<Record<AttestationClaim, string>> = {
  no_egress: "no network egress was attempted during the session",
  no_unauthorized_tool: "no tool call was made outside the authorized set",
  within_budget: "no spend/budget ceiling was exceeded",
};

/** The session summary the governor hands in. All counters are non-negative. */
export interface SessionSummary {
  /** ISO-8601 instant the session started. */
  startedAt: string;
  /** ISO-8601 instant the session ended. */
  endedAt: string;
  /** Number of times the agent tried to send data off-box (blocked or not). */
  egressAttempts: number;
  /** Number of tool calls made outside the authorized/pinned set. */
  unauthorizedToolCalls: number;
  /** True iff a spend or rate ceiling was breached at any point. */
  ceilingExceeded: boolean;
  /** Sensitive operations a human explicitly approved (disclosed, not hidden). */
  sensitiveApproved: string[];
}

export interface BuildAttestationInput {
  session: SessionSummary;
  /** Optional PEM (PKCS#8) Ed25519 private key. If absent, a fresh keypair is generated. */
  privateKeyPem?: string;
}

/** A signed negative attestation — independently re-verifiable with {@link verifyAttestation}. */
export interface SignedAttestation {
  /** The negative guarantees that held for this session, in canonical order. */
  claims: AttestationClaim[];
  /** The exact UTF-8 string that was signed. Recompute-and-compare to detect tampering. */
  canonical: string;
  /** Ed25519 signature over `canonical`, base64. */
  signature: string;
  /** Raw 32-byte Ed25519 public key, base64 — the key a verifier checks against. */
  publicKey: string;
}

/**
 * Derive the negative claims that genuinely held for a session.
 *
 * A claim is included ONLY when its counter proves the absence: `no_egress` iff
 * `egressAttempts === 0`, `no_unauthorized_tool` iff `unauthorizedToolCalls === 0`,
 * `within_budget` iff `!ceilingExceeded`. The result is always in {@link ALL_CLAIMS}
 * order so the canonical string is deterministic regardless of input shape.
 */
export function deriveClaims(session: SessionSummary): AttestationClaim[] {
  const held: AttestationClaim[] = [];
  if (session.egressAttempts === 0) held.push("no_egress");
  if (session.unauthorizedToolCalls === 0) held.push("no_unauthorized_tool");
  if (!session.ceilingExceeded) held.push("within_budget");
  return held;
}

/**
 * Build the exact string that gets signed. Stable, line-oriented, and trivially
 * recomputable cross-language: a fixed header, the window, then one `claim:` line
 * per held claim in canonical order. No JSON ambiguity (key order / whitespace).
 */
export function attestationCanonical(input: { startedAt: string; endedAt: string; claims: readonly AttestationClaim[] }): string {
  const ordered = ALL_CLAIMS.filter((c) => input.claims.includes(c));
  const lines = [
    "argus-negative-attestation/v1",
    `startedAt:${input.startedAt}`,
    `endedAt:${input.endedAt}`,
    `claims:${ordered.length}`,
    ...ordered.map((c) => `claim:${c}`),
  ];
  return lines.join("\n");
}

/** Build an Ed25519 KeyObject pair, from the supplied PEM or freshly generated. */
function keyPairFrom(privateKeyPem?: string): { privateKey: KeyObject; publicKey: KeyObject } {
  if (privateKeyPem !== undefined) {
    const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`attest: private key must be Ed25519, got ${privateKey.asymmetricKeyType ?? "unknown"}`);
    }
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

/** Extract the raw 32-byte Ed25519 public key (base64) from a public KeyObject. */
function rawPublicKeyB64(publicKey: KeyObject): string {
  // SPKI DER for Ed25519 is a fixed 12-byte prefix followed by the 32-byte key.
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

/**
 * Build a signed negative attestation for a finished session.
 *
 * Derives the held claims (see {@link deriveClaims}), canonicalizes the window +
 * claims (see {@link attestationCanonical}), Ed25519-signs that exact string, and
 * returns everything a third party needs to re-check it — no trust in ARGUS required.
 * When no `privateKeyPem` is given a fresh ephemeral keypair is generated and its
 * public key returned, so the attestation is still self-verifying.
 */
export function buildAttestation(input: BuildAttestationInput): SignedAttestation {
  const { session } = input;
  const claims = deriveClaims(session);
  const canonical = attestationCanonical({ startedAt: session.startedAt, endedAt: session.endedAt, claims });
  const { privateKey, publicKey } = keyPairFrom(input.privateKeyPem);
  const signature = nodeSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  return {
    claims,
    canonical,
    signature,
    publicKey: rawPublicKeyB64(publicKey),
  };
}

/** Rebuild an Ed25519 public KeyObject from a raw 32-byte key (base64) via SPKI DER. */
function ed25519FromRaw(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error(`attest: ed25519 public key must be 32 bytes, got ${raw.length}`);
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Re-verify a signed attestation purely locally: check the Ed25519 signature over
 * the attestation's own `canonical` string. Returns false (never throws) on any
 * malformed input, key, or tampered canonical/signature.
 *
 * Note: this proves the canonical string was signed by the holder of `publicKey`.
 * It does NOT re-derive claims from a session (the verifier may not have one); to
 * also confirm the claims match the canonical, use {@link claimsMatchCanonical}.
 */
export function verifyAttestation(att: SignedAttestation): boolean {
  try {
    if (!att || typeof att.canonical !== "string" || typeof att.signature !== "string" || typeof att.publicKey !== "string") {
      return false;
    }
    return nodeVerify(null, Buffer.from(att.canonical, "utf8"), ed25519FromRaw(att.publicKey), Buffer.from(att.signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Confirm the attestation's `claims` array is exactly the set encoded in its
 * `canonical` string (defends against a claims/canonical mismatch even when the
 * signature is valid). Combine with {@link verifyAttestation} for a full check.
 */
export function claimsMatchCanonical(att: SignedAttestation): boolean {
  const expected = attestationCanonical({
    startedAt: extractField(att.canonical, "startedAt"),
    endedAt: extractField(att.canonical, "endedAt"),
    claims: att.claims,
  });
  return expected === att.canonical;
}

/** Pull a single `key:value` field's value out of a canonical block (first match). */
function extractField(canonical: string, key: string): string {
  const prefix = `${key}:`;
  for (const line of canonical.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return "";
}
