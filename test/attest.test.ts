import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  buildAttestation,
  verifyAttestation,
  deriveClaims,
  attestationCanonical,
  claimsMatchCanonical,
  ALL_CLAIMS,
  CLAIM_MEANING,
  type SessionSummary,
  type SignedAttestation,
} from "../src/attest/index.js";

const cleanSession: SessionSummary = {
  startedAt: "2026-06-22T10:00:00.000Z",
  endedAt: "2026-06-22T10:05:00.000Z",
  egressAttempts: 0,
  unauthorizedToolCalls: 0,
  ceilingExceeded: false,
  sensitiveApproved: [],
};

describe("deriveClaims", () => {
  it("includes all three claims for a fully clean session", () => {
    expect(deriveClaims(cleanSession)).toEqual(["no_egress", "no_unauthorized_tool", "within_budget"]);
  });

  it("drops no_egress when egress was attempted", () => {
    const claims = deriveClaims({ ...cleanSession, egressAttempts: 3 });
    expect(claims).not.toContain("no_egress");
    expect(claims).toEqual(["no_unauthorized_tool", "within_budget"]);
  });

  it("drops no_unauthorized_tool when an unauthorized tool was called", () => {
    const claims = deriveClaims({ ...cleanSession, unauthorizedToolCalls: 1 });
    expect(claims).not.toContain("no_unauthorized_tool");
  });

  it("drops within_budget when a ceiling was exceeded", () => {
    const claims = deriveClaims({ ...cleanSession, ceilingExceeded: true });
    expect(claims).not.toContain("within_budget");
  });

  it("yields no claims for a maximally bad session", () => {
    expect(
      deriveClaims({ ...cleanSession, egressAttempts: 9, unauthorizedToolCalls: 2, ceilingExceeded: true }),
    ).toEqual([]);
  });

  it("always returns claims in canonical order regardless of which dropped", () => {
    // Only egress is bad -> remaining two must stay in ALL_CLAIMS order.
    const claims = deriveClaims({ ...cleanSession, egressAttempts: 1 });
    const indices = claims.map((c) => ALL_CLAIMS.indexOf(c));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("attestationCanonical", () => {
  it("is deterministic and includes a versioned header + claim count", () => {
    const c = attestationCanonical({ startedAt: cleanSession.startedAt, endedAt: cleanSession.endedAt, claims: deriveClaims(cleanSession) });
    expect(c.split("\n")[0]).toBe("argus-negative-attestation/v1");
    expect(c).toContain("claims:3");
    expect(c).toContain("claim:no_egress");
    expect(c).toContain(`startedAt:${cleanSession.startedAt}`);
  });

  it("normalizes claim order even if caller passes them shuffled", () => {
    const a = attestationCanonical({ startedAt: "s", endedAt: "e", claims: ["within_budget", "no_egress", "no_unauthorized_tool"] });
    const b = attestationCanonical({ startedAt: "s", endedAt: "e", claims: ["no_egress", "no_unauthorized_tool", "within_budget"] });
    expect(a).toBe(b);
  });

  it("encodes claims:0 with no claim lines for an empty set", () => {
    const c = attestationCanonical({ startedAt: "s", endedAt: "e", claims: [] });
    expect(c).toContain("claims:0");
    expect(c).not.toContain("claim:");
  });
});

describe("buildAttestation / verifyAttestation", () => {
  it("clean session -> all 3 claims and verifies true", () => {
    const att = buildAttestation({ session: cleanSession });
    expect(att.claims).toEqual(["no_egress", "no_unauthorized_tool", "within_budget"]);
    expect(verifyAttestation(att)).toBe(true);
    expect(claimsMatchCanonical(att)).toBe(true);
  });

  it("generates an ephemeral keypair when no PEM is supplied (32-byte b64 pubkey)", () => {
    const att = buildAttestation({ session: cleanSession });
    expect(Buffer.from(att.publicKey, "base64").length).toBe(32);
    expect(att.signature.length).toBeGreaterThan(0);
  });

  it("session with egress -> no_egress absent but still self-verifies", () => {
    const att = buildAttestation({ session: { ...cleanSession, egressAttempts: 2 } });
    expect(att.claims).not.toContain("no_egress");
    expect(att.claims).toEqual(["no_unauthorized_tool", "within_budget"]);
    expect(att.canonical).not.toContain("claim:no_egress");
    expect(verifyAttestation(att)).toBe(true);
  });

  it("signs with a supplied PEM private key and verifies", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const att = buildAttestation({ session: cleanSession, privateKeyPem: pem });
    expect(verifyAttestation(att)).toBe(true);
  });

  it("is reproducible: same key + same session -> identical signature (Ed25519 is deterministic)", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const a = buildAttestation({ session: cleanSession, privateKeyPem: pem });
    const b = buildAttestation({ session: cleanSession, privateKeyPem: pem });
    expect(a.signature).toBe(b.signature);
    expect(a.canonical).toBe(b.canonical);
    expect(a.publicKey).toBe(b.publicKey);
  });

  it("rejects a non-Ed25519 PEM key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => buildAttestation({ session: cleanSession, privateKeyPem: pem })).toThrow(/Ed25519/);
  });
});

describe("tamper resistance", () => {
  it("tampering the canonical string -> verify false", () => {
    const att = buildAttestation({ session: cleanSession });
    const tampered: SignedAttestation = { ...att, canonical: att.canonical.replace("claims:3", "claims:9") };
    expect(verifyAttestation(tampered)).toBe(false);
  });

  it("forging a claim into the canonical -> verify false", () => {
    const att = buildAttestation({ session: { ...cleanSession, egressAttempts: 1 } });
    // Try to sneak no_egress back in.
    const forged: SignedAttestation = {
      ...att,
      canonical: att.canonical.replace("claims:2", "claims:3") + "\nclaim:no_egress",
    };
    expect(verifyAttestation(forged)).toBe(false);
  });

  it("flipping a signature byte -> verify false", () => {
    const att = buildAttestation({ session: cleanSession });
    const buf = Buffer.from(att.signature, "base64");
    buf[0] = (buf[0] ?? 0) ^ 0xff;
    expect(verifyAttestation({ ...att, signature: buf.toString("base64") })).toBe(false);
  });

  it("substituting a different public key -> verify false", () => {
    const att = buildAttestation({ session: cleanSession });
    const other = buildAttestation({ session: cleanSession }); // fresh ephemeral key
    expect(verifyAttestation({ ...att, publicKey: other.publicKey })).toBe(false);
  });

  it("does not throw and returns false on malformed inputs", () => {
    expect(verifyAttestation({ claims: [], canonical: "x", signature: "!!!notb64", publicKey: "short" })).toBe(false);
    // @ts-expect-error intentionally malformed for runtime robustness check
    expect(verifyAttestation(null)).toBe(false);
    // @ts-expect-error intentionally malformed
    expect(verifyAttestation({})).toBe(false);
  });

  it("claimsMatchCanonical catches a claims-array / canonical mismatch even with a valid signature", () => {
    const att = buildAttestation({ session: cleanSession });
    // Signature still valid over canonical, but the claims array lies.
    const lying: SignedAttestation = { ...att, claims: ["no_egress"] };
    expect(verifyAttestation(lying)).toBe(true); // signature is over canonical, untouched
    expect(claimsMatchCanonical(lying)).toBe(false); // but the claims array disagrees
  });
});

describe("exported metadata", () => {
  it("CLAIM_MEANING covers every claim in ALL_CLAIMS", () => {
    for (const c of ALL_CLAIMS) {
      expect(typeof CLAIM_MEANING[c]).toBe("string");
      expect(CLAIM_MEANING[c].length).toBeGreaterThan(0);
    }
  });
});
