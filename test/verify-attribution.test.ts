import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { receiptCanonical, verifyArtifact } from "../src/verify/index.js";

/** A bundle forged end to end: the attacker signs with a key they generated themselves and
 *  ships that key inside the artifact. Every signature check inside it therefore succeeds. */
function forgeReceipt() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const receipt = { capability_id: "sortes.draw@v1", nonce: "n1", price_usd: 0 } as Record<string, unknown>;
  const value = nodeSign(null, Buffer.from(receiptCanonical(receipt), "utf8"), privateKey)
    .toString("base64");
  return {
    type: "oracle-receipt" as const,
    receipt: { ...receipt, signature: { value } },
    signerPublicKey: raw.toString("base64"),
  };
}

/**
 * `argus verify` checked oracle receipts and chain seals against keys carried INSIDE the
 * artifact being verified (`a.signerPublicKey`, `seal.publicKey`). Every other artifact type
 * is a self-recomputed SHA-256, so a fabricated bundle failed those — but a forger supplies
 * both the signature and the key, so the two signature claims passed and `argus verify`
 * reported the bundle as verified.
 *
 * A signature check can only ever say "these bytes are internally consistent under the key
 * that came with them". Attribution needs a key from outside the artifact.
 */
describe("a signature claim is only attributable under a trusted key", () => {
  const artifact = forgeReceipt();

  it("the forged bundle really is internally consistent — otherwise this proves nothing", () => {
    const [claim] = verifyArtifact(artifact);
    expect(claim.detail.toLowerCase()).not.toContain("invalid");
  });

  it("is not attributed when the verifier was given no trusted keys", () => {
    const [claim] = verifyArtifact(artifact);
    expect(claim.attributed).not.toBe(true);
    expect(claim.detail.toLowerCase()).toContain("unattributed");
  });

  it("fails outright when the artifact's key is not one the caller trusts", () => {
    const [claim] = verifyArtifact(artifact, { trustedSignerKeys: ["the-real-oracle-key"] });
    expect(claim.ok).toBe(false);
    expect(claim.attributed).toBe(false);
    expect(claim.detail).toContain("does not trust");
  });

  it("never reports a bare signature check as attributed provenance", () => {
    for (const opts of [undefined, { trustedSignerKeys: [] }]) {
      const [claim] = verifyArtifact(artifact, opts);
      expect(claim.attributed).not.toBe(true);
    }
  });

  it("still recomputes hash-based claims without needing any key", () => {
    const [claim] = verifyArtifact({
      type: "commitment",
      preimage: "hello",
      hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(claim.ok).toBe(true);
    // Nothing to attribute: the verifier derived this itself.
    expect(claim.attributed).toBeUndefined();
  });
});
