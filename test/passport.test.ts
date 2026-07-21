import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildPassport, renderPassport, passportArtifact, type PassportInput } from "../src/passport/index.js";
import { verifyArtifact, verifyBundle, sha256Hex } from "../src/verify/index.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A fully-attested input fixture. */
function attestedInput(over: Partial<PassportInput> = {}): PassportInput {
  return {
    handle: "argus",
    address: "0x029B0000000000000000000000000000000A8eb35",
    lumenScore: 0.8123456,
    lumenRank: "#3 of 142",
    graphCommitment: "DEADBEEFcafe",
    arena: { level: 7, streak: 12, winRate: 0.875, tasks: 40 },
    earnedUsd: 12.345,
    ...over,
  };
}

describe("buildPassport — attestation gating", () => {
  it("is attested when address, lumenScore and graphCommitment are all present", () => {
    const p = buildPassport(attestedInput());
    expect(p.attested).toBe(true);
    expect(p.preimage).toBeDefined();
    expect(p.commitment).toBeDefined();
  });

  it("is NOT attested when address is missing", () => {
    const p = buildPassport(attestedInput({ address: undefined }));
    expect(p.attested).toBe(false);
    expect(p.preimage).toBeUndefined();
    expect(p.commitment).toBeUndefined();
  });

  it("is NOT attested when lumenScore is missing", () => {
    const p = buildPassport(attestedInput({ lumenScore: undefined }));
    expect(p.attested).toBe(false);
    expect(p.commitment).toBeUndefined();
  });

  it("is NOT attested when graphCommitment is missing", () => {
    const p = buildPassport(attestedInput({ graphCommitment: undefined }));
    expect(p.attested).toBe(false);
    expect(p.commitment).toBeUndefined();
  });

  it("treats empty-string address/graphCommitment as not present", () => {
    expect(buildPassport(attestedInput({ address: "" })).attested).toBe(false);
    expect(buildPassport(attestedInput({ graphCommitment: "" })).attested).toBe(false);
  });

  it("treats a non-finite lumenScore (NaN) as missing", () => {
    const p = buildPassport(attestedInput({ lumenScore: Number.NaN }));
    expect(p.attested).toBe(false);
    expect(p.lumenScore).toBeUndefined();
  });

  it("attests with lumenScore 0 (a real, low score is not 'missing')", () => {
    const p = buildPassport(attestedInput({ lumenScore: 0 }));
    expect(p.attested).toBe(true);
    expect(p.lumenScore).toBe(0);
  });
});

describe("buildPassport — normalization & carry-through", () => {
  it("clamps winRate into [0,1] and truncates integer arena fields", () => {
    const p = buildPassport(attestedInput({ arena: { level: 3.9, streak: 5.7, winRate: 1.4, tasks: 10.2 } }));
    expect(p.arena.level).toBe(3);
    expect(p.arena.streak).toBe(5);
    expect(p.arena.winRate).toBe(1);
    expect(p.arena.tasks).toBe(10);
  });

  it("defaults earnedUsd to 0 and rounds to cents", () => {
    expect(buildPassport(attestedInput({ earnedUsd: undefined })).earnedUsd).toBe(0);
    expect(buildPassport(attestedInput({ earnedUsd: 12.345 })).earnedUsd).toBe(12.35);
  });

  it("carries display fields through even when unattested", () => {
    const p = buildPassport(attestedInput({ graphCommitment: undefined }));
    expect(p.attested).toBe(false);
    expect(p.address).toBeDefined();
    expect(p.lumenScore).toBe(0.8123456);
    expect(p.lumenRank).toBe("#3 of 142");
  });
});

describe("buildPassport — canonical commitment", () => {
  it("commitment is exactly sha256 of the pre-image it embeds", () => {
    const p = buildPassport(attestedInput());
    expect(p.preimage).toBeDefined();
    expect(p.commitment).toBe(sha(p.preimage!));
    // and matches the verify module's own sha256 helper byte-for-byte
    expect(p.commitment).toBe(sha256Hex(p.preimage!));
  });

  it("pre-image is deterministic and field-ordered", () => {
    const a = buildPassport(attestedInput());
    const b = buildPassport(attestedInput());
    expect(a.preimage).toBe(b.preimage);
    expect(a.preimage).toMatch(/^argus-passport:v1\|handle:argus\|address:0x/);
    expect(a.preimage).toContain("|graph_commitment:deadbeefcafe|"); // lowercased
    expect(a.preimage).toContain("|arena_win_rate:0.875|");
  });

  it("changing any reputation fact changes the commitment", () => {
    const base = buildPassport(attestedInput()).commitment;
    expect(buildPassport(attestedInput({ lumenScore: 0.9 })).commitment).not.toBe(base);
    expect(buildPassport(attestedInput({ arena: { level: 7, streak: 12, winRate: 0.875, tasks: 41 } })).commitment).not.toBe(base);
    expect(buildPassport(attestedInput({ earnedUsd: 99 })).commitment).not.toBe(base);
  });

  it("normalizes address case so equivalent addresses commit identically", () => {
    const lower = buildPassport(attestedInput({ address: "0xabc0000000000000000000000000000000000def" }));
    const upper = buildPassport(attestedInput({ address: "0xABC0000000000000000000000000000000000DEF" }));
    expect(lower.commitment).toBe(upper.commitment);
  });
});

describe("renderPassport", () => {
  it("renders an attested card with the LUMEN score and a verifiable footer", () => {
    const card = renderPassport(buildPassport(attestedInput()));
    expect(card).toContain("ARGUS · PASSPORT");
    expect(card).toContain("@argus");
    expect(card).toContain("0.812"); // lumenScore to 3dp
    expect(card).toContain("#3 of 142");
    expect(card).toContain("✔ verifiable");
    expect(card).not.toContain("connect wallet");
    expect(card).not.toContain("local · unattested");
  });

  it("renders an unattested card with the connect-wallet line and unattested label", () => {
    const card = renderPassport(buildPassport(attestedInput({ address: undefined, lumenScore: undefined, graphCommitment: undefined })));
    expect(card).toContain("— (connect wallet)");
    expect(card).toContain("local · unattested");
    expect(card).not.toContain("✔ verifiable");
  });

  it("every rendered row has identical visual width (box stays aligned)", () => {
    // Same display-width model the renderer uses: emoji are 2 cells, FE0F is 0.
    const visualWidth = (s: string): number => {
      let w = 0;
      for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp === 0xfe0f) continue;
        w += cp >= 0x1f300 || cp === 0x2b50 ? 2 : 1;
      }
      return w;
    };
    const card = renderPassport(buildPassport(attestedInput()));
    const rows = card.split("\n");
    const widths = new Set(rows.map((r) => visualWidth(r)));
    // Every line — borders, body rows, footer — must occupy the same cell width
    // so the right-hand ║ column lines up. (Raw code-point length differs because
    // emoji are 1–2 code points but 2 cells; visual width is what aligns.)
    expect(widths.size).toBe(1);
  });
});

describe("passportArtifact", () => {
  it("returns a commitment artifact only when attested", () => {
    const attested = passportArtifact(buildPassport(attestedInput()));
    expect(attested).not.toBeNull();
    expect(attested?.type).toBe("commitment");

    const unattested = passportArtifact(buildPassport(attestedInput({ graphCommitment: undefined })));
    expect(unattested).toBeNull();
  });

  it("the artifact re-verifies through the verify module (round-trip proof)", () => {
    const art = passportArtifact(buildPassport(attestedInput()));
    expect(art).not.toBeNull();
    const [claim] = verifyArtifact(art!);
    expect(claim.ok).toBe(true);
    expect(verifyBundle([art!]).ok).toBe(true);
  });

  it("tampering with the pre-image after the fact fails verification", () => {
    const p = buildPassport(attestedInput());
    const art = passportArtifact(p)!;
    // counterparty was handed a forged card claiming a higher earned total
    const forged = { ...art, preimage: art.preimage.replace("earned_usd:12.35", "earned_usd:9999.00") };
    expect(verifyArtifact(forged)[0].ok).toBe(false);
  });

  it("a mismatched hash (claim ≠ pre-image) fails verification", () => {
    const art = passportArtifact(buildPassport(attestedInput()))!;
    expect(verifyArtifact({ ...art, hash: "deadbeef" })[0].ok).toBe(false);
  });
});
