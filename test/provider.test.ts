import { describe, it, expect } from "vitest";
import { buildServingReceipt, verifyServingReceipt, newServingKey, sha256Hex, servingCanonical } from "../src/provider/index.js";

function input(over: Partial<Parameters<typeof buildServingReceipt>[0]> = {}) {
  return {
    capability: "argus_ask",
    requestHash: sha256Hex("translate hello"),
    answerHash: sha256Hex("bonjour"),
    priceUsd: 0,
    providerId: "0xabc",
    timestamp: "2026-06-22T20:00:00Z",
    ...over,
  };
}

describe("provider serving receipts (G2)", () => {
  it("a signed serving receipt re-verifies locally", () => {
    const key = newServingKey();
    const r = buildServingReceipt(input(), key);
    expect(verifyServingReceipt(r)).toBe(true);
    expect(r.algorithm).toBe("ed25519");
  });

  it("self-verifies even with an ephemeral key (no signer supplied)", () => {
    expect(verifyServingReceipt(buildServingReceipt(input()))).toBe(true);
  });

  it("rejects a tampered receipt (price changed after signing)", () => {
    const r = buildServingReceipt(input({ priceUsd: 0.01 }), newServingKey());
    expect(verifyServingReceipt({ ...r, priceUsd: 0 })).toBe(false);
  });

  it("rejects a swapped answer (answerHash changed after signing)", () => {
    const r = buildServingReceipt(input(), newServingKey());
    expect(verifyServingReceipt({ ...r, answerHash: sha256Hex("different") })).toBe(false);
  });

  it("a stable key produces the same public key across receipts", () => {
    const key = newServingKey();
    const a = buildServingReceipt(input(), key);
    const b = buildServingReceipt(input({ timestamp: "2026-06-22T21:00:00Z" }), key);
    expect(a.publicKey).toBe(b.publicKey); // chains to one provider identity
    expect(a.canonical).not.toBe(b.canonical);
  });

  it("the canonical binds request, answer, price, provider and time", () => {
    const c = servingCanonical(input());
    for (const part of ["argus-serving:v1", "capability:argus_ask", "price_usd:0", "provider:0xabc"]) {
      expect(c).toContain(part);
    }
  });
});
