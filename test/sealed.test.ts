import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  appendApproval,
  verifyApprovalChain,
  canonicalApproval,
  approvalHash,
  chainHead,
  sealChain,
  verifySealedChain,
  generateAndSeal,
  headCommitment,
  GENESIS_PREV_HASH,
  type ApprovalEntry,
  type ApprovalRecord,
} from "../src/sealed/index.js";
import { verifyArtifact } from "../src/verify/index.js";

const rec = (n: number): ApprovalRecord => ({
  tool: `wallet_transfer_${n}`,
  argsHash: `args${n}`.padStart(8, "0"),
  toolsHash: `tools${n}`.padStart(8, "0"),
  timestamp: `2026-06-22T17:0${n}:00Z`,
});

function chainOf(count: number): ApprovalEntry[] {
  let c: ApprovalEntry[] = [];
  for (let i = 0; i < count; i++) c = appendApproval(c, rec(i));
  return c;
}

describe("sealed — appendApproval", () => {
  it("appends 3 entries with correct linkage and a clean verify", () => {
    const c = chainOf(3);
    expect(c).toHaveLength(3);
    const e0 = c[0]!;
    const e1 = c[1]!;
    const e2 = c[2]!;
    // genesis anchors to the sentinel
    expect(e0.prevHash).toBe(GENESIS_PREV_HASH);
    expect(e0.index).toBe(0);
    // each links to the previous hash
    expect(e1.prevHash).toBe(e0.hash);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e1.index).toBe(1);
    expect(e2.index).toBe(2);
    // hashes re-derive
    expect(e0.hash).toBe(approvalHash(GENESIS_PREV_HASH, e0));
    expect(e1.hash).toBe(approvalHash(e0.hash, e1));
    expect(verifyApprovalChain(c).ok).toBe(true);
    expect(verifyApprovalChain(c).brokenAt).toBeUndefined();
  });

  it("is append-only: never mutates its input array or entries", () => {
    const c1 = chainOf(2);
    const snapshot = JSON.stringify(c1);
    const c2 = appendApproval(c1, rec(99));
    expect(c1).toHaveLength(2);
    expect(c2).toHaveLength(3);
    expect(c2).not.toBe(c1);
    expect(JSON.stringify(c1)).toBe(snapshot); // original untouched
  });

  it("does not copy extra/stray fields from the input record into the entry", () => {
    const dirty = { ...rec(0), evil: "drop-me" } as unknown as ApprovalRecord;
    const [e] = appendApproval([], dirty);
    expect(e).toBeDefined();
    expect((e as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(verifyApprovalChain([e!]).ok).toBe(true);
  });

  it("an empty chain is vacuously ok", () => {
    expect(verifyApprovalChain([]).ok).toBe(true);
  });
});

describe("sealed — canonicalApproval framing", () => {
  it("distinguishes records that would collide under naive joining", () => {
    const a: ApprovalRecord = { tool: "a|b", argsHash: "x", toolsHash: "y", timestamp: "t" };
    const b: ApprovalRecord = { tool: "a", argsHash: "b|x", toolsHash: "y", timestamp: "t" };
    expect(canonicalApproval(a)).not.toBe(canonicalApproval(b));
    expect(approvalHash("0", a)).not.toBe(approvalHash("0", b));
  });
});

describe("sealed — tamper detection", () => {
  it("tampering with an entry's tool breaks verify at that index", () => {
    const c = chainOf(3);
    const bad = c.map((e, i) => (i === 1 ? { ...e, tool: "wallet_drain" } : e));
    const res = verifyApprovalChain(bad);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it("tampering with an entry's argsHash breaks verify at that index", () => {
    const c = chainOf(3);
    const bad = c.map((e, i) => (i === 2 ? { ...e, argsHash: "ffffffff" } : e));
    const res = verifyApprovalChain(bad);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2);
  });

  it("tampering with the genesis entry breaks at index 0", () => {
    const c = chainOf(2);
    const bad = c.map((e, i) => (i === 0 ? { ...e, toolsHash: "deadbeef" } : e));
    const res = verifyApprovalChain(bad);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(0);
  });

  it("swapping a stored hash without recomputing downstream is caught", () => {
    const c = chainOf(3);
    // forge entry 1's hash to a plausible value; its own re-derive fails first
    const bad = c.map((e, i) => (i === 1 ? { ...e, hash: approvalHash("0", rec(42)) } : e));
    const res = verifyApprovalChain(bad);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it("reordering entries breaks the chain", () => {
    const c = chainOf(3);
    const reordered = [c[0]!, c[2]!, c[1]!];
    const res = verifyApprovalChain(reordered);
    expect(res.ok).toBe(false);
    // position 1 now holds entry whose index is 2 -> contiguity/link fails there
    expect(res.brokenAt).toBe(1);
  });

  it("deleting (splicing out) a middle entry breaks the chain", () => {
    const c = chainOf(3);
    const spliced = [c[0]!, c[2]!];
    const res = verifyApprovalChain(spliced);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it("a re-pointed prevHash that still self-hashes is caught by the link check", () => {
    const c = chainOf(3);
    // make entry 2 a valid self-hash against a wrong prev (genesis), breaking the link
    const forgedPrev = GENESIS_PREV_HASH;
    const e2 = c[2]!;
    const forged: ApprovalEntry = { ...e2, prevHash: forgedPrev, hash: approvalHash(forgedPrev, e2) };
    const bad = [c[0]!, c[1]!, forged];
    const res = verifyApprovalChain(bad);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2); // prevHash != entry1.hash
  });
});

describe("sealed — chainHead", () => {
  it("returns the sentinel for an empty chain and the last hash otherwise", () => {
    expect(chainHead([])).toBe(GENESIS_PREV_HASH);
    const c = chainOf(2);
    expect(chainHead(c)).toBe(c[1]!.hash);
  });
});

describe("sealed — Ed25519 seal", () => {
  it("seals a head and verifies it back", () => {
    const c = chainOf(3);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seal = sealChain(c, privateKey, publicKey);
    expect(seal.head).toBe(chainHead(c));
    expect(verifySealedChain(c, seal)).toBe(true);
  });

  it("generateAndSeal mints a key and produces a valid seal", () => {
    const c = chainOf(2);
    const { seal } = generateAndSeal(c);
    expect(verifySealedChain(c, seal)).toBe(true);
  });

  it("a seal does not verify against a chain whose head changed (appended after sealing)", () => {
    const c = chainOf(2);
    const { seal } = generateAndSeal(c);
    const grown = appendApproval(c, rec(7));
    expect(verifySealedChain(grown, seal)).toBe(false);
  });

  it("a seal does not verify if the underlying chain was tampered", () => {
    const c = chainOf(3);
    const { seal } = generateAndSeal(c);
    const bad = c.map((e, i) => (i === 0 ? { ...e, tool: "evil" } : e));
    expect(verifySealedChain(bad, seal)).toBe(false);
  });

  it("a seal signed by another key fails verification", () => {
    const c = chainOf(2);
    const { seal } = generateAndSeal(c);
    const other = generateKeyPairSync("ed25519");
    const forged = { ...seal, publicKey: (other.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64") };
    expect(verifySealedChain(c, forged)).toBe(false);
  });

  it("a garbage public key fails closed rather than throwing", () => {
    const c = chainOf(1);
    const { seal } = generateAndSeal(c);
    const forged = { ...seal, publicKey: "not-a-real-key" };
    expect(verifySealedChain(c, forged)).toBe(false);
  });
});

describe("sealed — headCommitment interop with argus verify", () => {
  it("the head commitment re-verifies under verifyArtifact, and breaks if the head is altered", () => {
    const c = chainOf(3);
    const art = headCommitment(c);
    expect(art).not.toBeNull();
    const [claim] = verifyArtifact(art!);
    expect(claim!.ok).toBe(true);

    // tamper the claimed hash -> commitment no longer matches its preimage
    const tampered = { ...art!, hash: "deadbeef" } as typeof art;
    const [bad] = verifyArtifact(tampered!);
    expect(bad!.ok).toBe(false);
  });

  it("headCommitment is null for an empty chain", () => {
    expect(headCommitment([])).toBeNull();
  });
});
