/**
 * AIMarket agent mandates (aimarket-protocol/mandates.md) — the ARGUS side.
 *
 * An owner signs a mandate for ARGUS's own Ed25519 key: how much it may spend, on which
 * capabilities, at which hubs, until when. ARGUS presents it on every paid call with a proof
 * that it holds that key; the hub enforces the limits and pays from the owner's account. ARGUS
 * never holds the owner's API key, and needs no wallet or chain — mandates ride the hub's
 * credits rail.
 *
 * Distinct from `src/mandate/` (ARGUS's self-sealed task commitment): that one is ARGUS
 * promising itself a budget; this one is an owner authorising a budget, enforced by a hub.
 *
 * No dependencies beyond node:crypto:
 *  - canonical JSON (RFC 8785) for the integer-only documents mandates are: JavaScript's own
 *    `JSON.stringify` IS the ECMAScript serialization RFC 8785 is defined by, and a plain
 *    `.sort()` of string keys compares UTF-16 code units, which is exactly the JCS key order;
 *  - Ed25519 via node:crypto; did:key = multibase base58btc of 0xed01 || raw public key;
 *  - the proof suite eddsa-jcs-2022 exactly as the AWR/2 reference implementation builds it.
 * `test/aimarket-mandate.test.ts` rebuilds the protocol's normative vectors byte for byte.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const MANDATE_HEADER = "X-AIMarket-Mandate";
export const PROOF_HEADER = "X-AIMarket-Mandate-Proof";
export const JOB_HEADER = "X-AIMarket-Job";
export const GRANT_HEADER = "X-AIMarket-Job-Grant";
const VC_CONTEXT = "https://www.w3.org/ns/credentials/v2";
const MICRO_PER_USD = 1_000_000;

// ── canonical JSON (RFC 8785, integer-only subset) ───────────────────────

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("mandates carry integers only (µUSD); got a non-integer number");
    return String(value);
  }
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdfff) {
        const next = value.charCodeAt(i + 1);
        if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
        throw new Error("lone surrogate in a mandate string");
      }
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

const sha256 = (data: string | Buffer): Buffer => createHash("sha256").update(data).digest();

export function b64url(data: Buffer): string {
  return data.toString("base64url");
}

/** `sha256-<base64>` over the canonical form of the SECURED document (mandates.md §3.3). */
export function mandateDigest(document: unknown): string {
  return `sha256-${sha256(canonicalize(document)).toString("base64")}`;
}

// ── base58btc and did:key ────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58encode(data: Buffer): string {
  let n = BigInt(`0x${data.toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < data.length && data[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}

export function base58decode(text: string): Buffer {
  let n = 0n;
  for (const ch of text) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 character ${ch}`);
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
// PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// SPKI DER prefix for an Ed25519 public key; the 32 raw bytes follow.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function publicKeyOfDid(did: string): KeyObject {
  if (!did.startsWith("did:key:z")) throw new Error("not a did:key");
  const raw = base58decode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("not an Ed25519 did:key");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw.subarray(2)]), format: "der", type: "spki" });
}

export class AgentKey {
  readonly did: string;
  readonly verificationMethod: string;
  private readonly key: KeyObject;
  private readonly seed: Buffer;

  private constructor(seed: Buffer) {
    if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
    this.seed = Buffer.from(seed);
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    const jwk = createPublicKey(this.key).export({ format: "jwk" }) as { x: string };
    const raw = Buffer.from(jwk.x, "base64url");
    this.did = `did:key:z${base58encode(Buffer.concat([ED25519_MULTICODEC, raw]))}`;
    this.verificationMethod = `${this.did}#${this.did.slice("did:key:".length)}`;
  }

  static generate(): AgentKey {
    return new AgentKey(randomBytes(32));
  }

  static fromSeedHex(hex: string): AgentKey {
    const clean = hex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("agent key must be 64 hex characters (a 32-byte Ed25519 seed)");
    return new AgentKey(Buffer.from(clean, "hex"));
  }

  seedHex(): string {
    return this.seed.toString("hex");
  }

  sign(message: Buffer | string): Buffer {
    return sign(null, typeof message === "string" ? Buffer.from(message, "utf8") : message, this.key);
  }
}

// ── the mandate document (eddsa-jcs-2022) ────────────────────────────────

type Json = Record<string, unknown>;

/** Attach an eddsa-jcs-2022 DataIntegrityProof exactly as the AWR/2 reference does. */
export function signDocument(document: Json, key: AgentKey, created: string): Json {
  const unsecured: Json = { ...document };
  delete unsecured.proof;
  const options: Json = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    created,
    verificationMethod: key.verificationMethod,
    proofPurpose: "assertionMethod",
  };
  const config: Json = { ...options };
  if ("@context" in unsecured) config["@context"] = unsecured["@context"];
  const hashData = Buffer.concat([sha256(canonicalize(config)), sha256(canonicalize(unsecured))]);
  const proof: Json = {};
  if ("@context" in unsecured) proof["@context"] = unsecured["@context"];
  Object.assign(proof, options, { proofValue: `z${base58encode(key.sign(hashData))}` });
  return { ...unsecured, proof };
}

export function verifyDocument(document: Json): boolean {
  const proof = document.proof as Json | undefined;
  if (!proof || typeof proof.proofValue !== "string" || !proof.proofValue.startsWith("z")) return false;
  const unsecured: Json = { ...document };
  delete unsecured.proof;
  const config: Json = { ...proof };
  delete config.proofValue;
  if ("@context" in unsecured) config["@context"] = unsecured["@context"];
  try {
    const hashData = Buffer.concat([sha256(canonicalize(config)), sha256(canonicalize(unsecured))]);
    return verify(null, hashData, publicKeyOfDid(String(document.issuer)), base58decode(proof.proofValue.slice(1)));
  } catch {
    return false;
  }
}

export const usd = (amount: number): number => Math.round(amount * MICRO_PER_USD);
const ts = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export interface IssueMandateOptions {
  audience: string[];
  scope: string[];
  perCallUsd: number;
  perDayUsd: number;
  totalUsd?: number;
  perProductPerDayUsd?: number;
  subcontractAllowanceUsd?: number;
  subcontractMaxDepth?: number;
  /** The parent mandate (or its digest) for a re-delegation. */
  parent?: Json | string;
  validDays?: number;
  validFrom?: Date;
}

/**
 * Build and sign a mandate. ARGUS uses this to RE-DELEGATE: to hand a sub-agent part of its
 * own authority. The hub then requires the child to be narrower in every respect (§3.4).
 */
export function issueMandate(issuer: AgentKey, subjectDid: string, o: IssueMandateOptions): Json {
  const start = new Date(Math.floor((o.validFrom ?? new Date()).getTime() / 1000) * 1000);
  const limits: Record<string, number> = { perCall: usd(o.perCallUsd), perDay: usd(o.perDayUsd) };
  if (o.totalUsd != null) limits.total = usd(o.totalUsd);
  if (o.perProductPerDayUsd != null) limits.perProductPerDay = usd(o.perProductPerDayUsd);
  const body: Json = {
    version: 1,
    audience: o.audience.map((a) => a.replace(/\/+$/, "")),
    scope: [...o.scope],
    limits,
  };
  if (o.subcontractAllowanceUsd != null) {
    body.subcontract = { perCallAllowance: usd(o.subcontractAllowanceUsd), maxDepth: o.subcontractMaxDepth ?? 1 };
  }
  if (o.parent != null) body.parent = typeof o.parent === "string" ? o.parent : mandateDigest(o.parent);
  const end = new Date(start.getTime() + (o.validDays ?? 30) * 86_400_000);
  const document: Json = {
    "@context": [VC_CONTEXT],
    type: ["VerifiableCredential", "AIMarketMandate"],
    id: `urn:uuid:${randomUUID()}`,
    issuer: issuer.did,
    validFrom: ts(start),
    validUntil: ts(end),
    credentialSubject: { id: subjectDid, aimarketMandate: body },
  };
  return signDocument(document, issuer, ts(new Date()));
}

// ── the request proof (§5.1) ─────────────────────────────────────────────

export function requestMessage(o: {
  hubOrigin: string; method: string; path: string; digest: string; t: number; nonce: string; body: Buffer | string;
}): string {
  const bodyHash = createHash("sha256").update(typeof o.body === "string" ? Buffer.from(o.body, "utf8") : o.body).digest("hex");
  return [
    "aimarket-mandate-request/1", o.hubOrigin.replace(/\/+$/, ""), `${o.method.toUpperCase()} ${o.path}`,
    o.digest, String(Math.trunc(o.t)), o.nonce, bodyHash,
  ].join("\n");
}

export function requestProof(key: AgentKey, o: {
  hubOrigin: string; leafDigest: string; body: Buffer | string; method?: string; path?: string; t?: number; nonce?: string;
}): string {
  const t = o.t ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? randomBytes(18).toString("base64url");
  const message = requestMessage({
    hubOrigin: o.hubOrigin, method: o.method ?? "POST", path: o.path ?? "/ai-market/v2/invoke",
    digest: o.leafDigest, t, nonce, body: o.body,
  });
  return `t=${t};n=${nonce};s=${b64url(key.sign(message))}`;
}

/** A mandate ARGUS holds: the document, ARGUS's own key, and the hub it spends at. */
export class MandateCredential {
  readonly digest: string;

  constructor(readonly document: Json, readonly key: AgentKey, readonly hubOrigin: string) {
    const subject = (document.credentialSubject as Json | undefined)?.id;
    if (subject !== key.did) {
      throw new Error(`this mandate is issued to ${String(subject)}, not to ARGUS's key ${key.did}`);
    }
    this.digest = mandateDigest(document);
  }

  headers(body: string, method = "POST", path = "/ai-market/v2/invoke"): Record<string, string> {
    return {
      [MANDATE_HEADER]: this.digest,
      [PROOF_HEADER]: requestProof(this.key, { hubOrigin: this.hubOrigin, leafDigest: this.digest, body, method, path }),
    };
  }

  /** What the mandate lets ARGUS spend, in USD (for budget planning and `argus mandate status`). */
  limitsUsd(): Record<string, number> {
    const limits = (((this.document.credentialSubject as Json).aimarketMandate as Json).limits ?? {}) as Record<string, number>;
    return Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v / MICRO_PER_USD]));
  }
}
