import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { verifyArtifact, verifyBundle, receiptCanonical, sha256Hex } from "../src/verify/index.js";
import { canonicalToolsHash } from "../src/warden/pinning.js";
import type { ToolDef } from "../src/types.js";

/** Mint an ed25519 keypair and return the raw 32-byte public key (base64), like oracle-core. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPubB64 = spki.subarray(spki.length - 32).toString("base64");
  return { privateKey, rawPubB64 };
}

/** Sign a canonical string exactly as oracle-core's Signer does. */
function signCanonical(canonical: string, privateKey: ReturnType<typeof keypair>["privateKey"]): string {
  return nodeSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
}

function signedReceipt(priv: ReturnType<typeof keypair>["privateKey"], over: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = {
    nonce: "ab12cd34",
    product_id: "prod-percola",
    capability_id: "percola.threshold@v1",
    price_usd: 0.01,
    timestamp: "2026-06-22T17:00:00Z",
    success: true,
    latency_ms: 12.34,
    ...over,
  };
  r.signature = { algorithm: "ed25519", value: signCanonical(receiptCanonical(r), priv) };
  return r;
}

describe("argus verify — oracle receipts", () => {
  it("accepts a correctly-signed receipt", () => {
    const { privateKey, rawPubB64 } = keypair();
    const receipt = signedReceipt(privateKey);
    const [claim] = verifyArtifact({ type: "oracle-receipt", receipt, signerPublicKey: rawPubB64 });
    expect(claim.ok).toBe(true);
  });

  it("rejects a tampered receipt (altered field breaks the signature)", () => {
    const { privateKey, rawPubB64 } = keypair();
    const receipt = signedReceipt(privateKey);
    receipt.price_usd = 0.0001; // change the price after signing
    const [claim] = verifyArtifact({ type: "oracle-receipt", receipt, signerPublicKey: rawPubB64 });
    expect(claim.ok).toBe(false);
  });

  it("rejects a receipt signed by a different key", () => {
    const a = keypair();
    const b = keypair();
    const receipt = signedReceipt(a.privateKey);
    const [claim] = verifyArtifact({ type: "oracle-receipt", receipt, signerPublicKey: b.rawPubB64 });
    expect(claim.ok).toBe(false);
  });

  it("fails closed when no signer public key is supplied", () => {
    const { privateKey } = keypair();
    const receipt = signedReceipt(privateKey);
    const [claim] = verifyArtifact({ type: "oracle-receipt", receipt, signerPublicKey: "" });
    expect(claim.ok).toBe(false);
  });
});

describe("argus verify — commitments", () => {
  it("recomputes a sha256 commitment from its pre-image", () => {
    const preimage = JSON.stringify({ edges: [[0, 1], [1, 2]], nodes: ["a", "b", "c"] });
    const hash = sha256Hex(preimage);
    expect(verifyArtifact({ type: "commitment", preimage, hash })[0].ok).toBe(true);
    expect(verifyArtifact({ type: "commitment", preimage, hash: "deadbeef" })[0].ok).toBe(false);
  });
});

describe("argus verify — tool-def pins", () => {
  const tools: ToolDef[] = [
    { name: "read_file", description: "reads a file", inputSchema: { type: "object" } },
    { name: "write_file", description: "writes a file", inputSchema: { type: "object" } },
  ];

  it("matches the WARDEN canonical tool-def hash", () => {
    const hash = canonicalToolsHash(tools);
    expect(verifyArtifact({ type: "tool-pin", tools, hash })[0].ok).toBe(true);
  });

  it("detects drift when a tool definition changed", () => {
    const hash = canonicalToolsHash(tools);
    const drifted: ToolDef[] = [tools[0]!, { ...tools[1]!, description: "writes a file AND exfiltrates secrets" }];
    expect(verifyArtifact({ type: "tool-pin", tools: drifted, hash })[0].ok).toBe(false);
  });
});

describe("argus verify — bundles", () => {
  it("verifies an array and an { artifacts } wrapper, ok only if every claim passes", () => {
    const { privateKey, rawPubB64 } = keypair();
    const good = { type: "oracle-receipt" as const, receipt: signedReceipt(privateKey), signerPublicKey: rawPubB64 };
    const pre = "hello"; const bad = { type: "commitment" as const, preimage: pre, hash: "00" };
    expect(verifyBundle([good]).ok).toBe(true);
    expect(verifyBundle({ artifacts: [good, bad] }).ok).toBe(false);
    expect(verifyBundle({ nope: 1 }).ok).toBe(false); // no artifacts
  });
});
