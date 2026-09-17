import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { extractEntry, renderTrailer, ProvenanceCollector, toVerifyBundle } from "../src/provenance/index.js";
import { verifyBundle, receiptCanonical } from "../src/verify/index.js";

function signedOracleData() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPubB64 = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
  const receipt: Record<string, unknown> = {
    nonce: "n1", product_id: "prod-percola", capability_id: "percola.threshold@v1",
    price_usd: 0.01, timestamp: "2026-06-22T17:00:00Z", success: true, latency_ms: 12,
  };
  receipt.signature = { algorithm: "ed25519", value: nodeSign(null, Buffer.from(receiptCanonical(receipt), "utf8"), privateKey).toString("base64") };
  return { output: { f_c: 0.27 }, priceUsd: 0.01, receipt, signerPublicKey: rawPubB64 };
}

describe("provenance extraction", () => {
  it("records an oracle call with a re-verifiable artifact", () => {
    const e = extractEntry("oracle_call", signedOracleData())!;
    expect(e.source).toBe("oracle");
    expect(e.capabilityId).toBe("percola.threshold@v1");
    expect(e.priceUsd).toBe(0.01);
    expect(e.verifiable?.type).toBe("oracle-receipt");
  });

  it("records a hub invoke with its SDK receipt flag", () => {
    const e = extractEntry("hub_invoke", { ok: true, priceUsd: 0.004, capabilityId: "x.y@v1", receiptValid: true, trustScore: 0.8 })!;
    expect(e.source).toBe("hub");
    expect(e.receiptValid).toBe(true);
    expect(e.trustScore).toBe(0.8);
    expect(e.verifiable).toBeUndefined(); // SDK-internal, not a standalone artifact
  });

  it("ignores non-ecosystem tools and non-object data", () => {
    expect(extractEntry("web_fetch", { foo: 1 })).toBeNull();
    expect(extractEntry("oracle_call", "not an object")).toBeNull();
  });

  it("omits the verifiable artifact when the signer key is unknown (offline)", () => {
    const d = signedOracleData();
    delete (d as Record<string, unknown>).signerPublicKey;
    const e = extractEntry("oracle_call", d)!;
    expect(e.source).toBe("oracle");
    expect(e.verifiable).toBeUndefined(); // recorded, but not independently verifiable
  });
});

describe("provenance trailer", () => {
  it("states local answer when there are no external calls", () => {
    expect(renderTrailer([])).toContain("answered locally");
  });

  it("summarises external calls and how many are re-verifiable", () => {
    const c = new ProvenanceCollector();
    c.record("oracle_call", signedOracleData());
    c.record("hub_invoke", { priceUsd: 0.004, capabilityId: "x.y@v1", receiptValid: true });
    const text = renderTrailer(c.list());
    expect(text).toContain("2 external call(s), 1 re-verifiable");
    expect(text).toContain("percola.threshold@v1");
  });
});

describe("closed loop: provenance bundle → argus verify", () => {
  it("the bundle a provenance run emits passes argus verify", () => {
    const c = new ProvenanceCollector();
    c.record("oracle_call", signedOracleData());
    const bundle = toVerifyBundle(c.list());
    expect(bundle).toHaveLength(1);
    expect(verifyBundle(bundle).ok).toBe(true); // re-verified with pure local crypto
  });
});
