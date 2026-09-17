import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";

/**
 * Provider primitive (G2) — the minimal *honest* earn rail.
 *
 * ARGUS-3 is a complete consumer but, until now, a hollow provider: it could serve
 * `/ask` but produced nothing a buyer could later prove it had been served. This is
 * that missing artifact: a **serving receipt** — an Ed25519-signed statement that a
 * specific request → answer was served by this provider, at this price, at this time.
 * A buyer (or anyone) re-verifies it locally with pure crypto, no trust in ARGUS.
 *
 * It is the foundation the whole earn side needs: settlement itself still rides the
 * existing AIMarket escrow (the buyer opens a USDC channel and debits per call); this
 * primitive supplies the *verifiable proof of service* that a receipt-gated market
 * (reviews, refunds, reputation) is built on. Price is declared (0 = free) until a
 * channel is attached — never a fake charge.
 */
export interface ServingReceiptInput {
  /** What was served, e.g. "argus_ask". */
  capability: string;
  /** sha256 (hex) of the request. */
  requestHash: string;
  /** sha256 (hex) of the answer. */
  answerHash: string;
  /** Declared price in USD (0 when served free / no channel attached). */
  priceUsd: number;
  /** The provider's economic identity (e.g. its EVM address) or handle. */
  providerId: string;
  /** ISO-8601 timestamp of service. */
  timestamp: string;
}

export interface ServingReceipt extends ServingReceiptInput {
  canonical: string;
  algorithm: "ed25519";
  /** base64 Ed25519 signature over `canonical`. */
  signature: string;
  /** base64 raw (32-byte) Ed25519 public key. */
  publicKey: string;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Fixed canonical string the signature covers (version-tagged, pipe-delimited). */
export function servingCanonical(i: ServingReceiptInput): string {
  return [
    "argus-serving:v1",
    `capability:${i.capability}`,
    `request_hash:${i.requestHash}`,
    `answer_hash:${i.answerHash}`,
    `price_usd:${i.priceUsd}`,
    `provider:${i.providerId}`,
    `timestamp:${i.timestamp}`,
  ].join("|");
}

function rawPublicKeyB64(pub: KeyObject): string {
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("base64");
}

/** A stable per-process Ed25519 serving identity. Generate once, reuse for the session. */
export function newServingKey(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}

/** Sign a serving receipt. Uses the given key, or an ephemeral one that still self-verifies. */
export function buildServingReceipt(input: ServingReceiptInput, signer?: KeyObject): ServingReceipt {
  const priv = signer ?? newServingKey();
  const pub = createPublicKey(priv);
  const canonical = servingCanonical(input);
  const signature = nodeSign(null, Buffer.from(canonical, "utf8"), priv).toString("base64");
  return { ...input, canonical, algorithm: "ed25519", signature, publicKey: rawPublicKeyB64(pub) };
}

/** Re-verify a serving receipt locally — pure Ed25519, no network, no trust in the server. */
export function verifyServingReceipt(r: ServingReceipt): boolean {
  try {
    const raw = Buffer.from(r.publicKey, "base64");
    if (raw.length !== 32) return false;
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(servingCanonical(r), "utf8"), key, Buffer.from(r.signature, "base64"));
  } catch {
    return false;
  }
}
