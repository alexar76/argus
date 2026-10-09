import { describe, it, expect } from "vitest";
import { parseCiBadge, gateByCi, rankByCi } from "../src/ci/index.js";

/** A discovered capability carrying an explicit CI badge. */
function cap(ci: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { capabilityId: "x.y@v1", priceUsd: 0.01, ...extra, ci };
}

describe("parseCiBadge", () => {
  it("parses an explicit green badge with all fields", () => {
    const b = parseCiBadge(
      cap({ status: "green", passRate: 1, p95Ms: 120, lastGreen: "2026-06-22T10:00:00Z" }),
    );
    expect(b.status).toBe("green");
    expect(b.passRate).toBe(1);
    expect(b.p95Ms).toBe(120);
    expect(b.lastGreen).toBe("2026-06-22T10:00:00Z");
  });

  it("parses an explicit red badge", () => {
    const b = parseCiBadge(cap({ status: "red", passRate: 0.4, p95Ms: 900 }));
    expect(b.status).toBe("red");
    expect(b.passRate).toBe(0.4);
    expect(b.p95Ms).toBe(900);
    expect(b.lastGreen).toBeUndefined();
  });

  it("returns unknown when there is no ci field at all", () => {
    expect(parseCiBadge({ capabilityId: "x.y@v1" }).status).toBe("unknown");
  });

  it("returns unknown for a null or non-object ci field", () => {
    expect(parseCiBadge(cap(null)).status).toBe("unknown");
    expect(parseCiBadge(cap("green")).status).toBe("unknown");
    expect(parseCiBadge(cap(42)).status).toBe("unknown");
  });

  it("honours an explicit unknown status verbatim", () => {
    expect(parseCiBadge(cap({ status: "unknown", passRate: 1 })).status).toBe("unknown");
  });

  it("infers green when status is absent but passRate is perfect", () => {
    const b = parseCiBadge(cap({ passRate: 1 }));
    expect(b.status).toBe("green");
    expect(b.passRate).toBe(1);
  });

  it("infers red when status is absent and passRate is imperfect", () => {
    const b = parseCiBadge(cap({ passRate: 0.99 }));
    expect(b.status).toBe("red");
    expect(b.passRate).toBe(0.99);
  });

  it("stays unknown when status is absent and there is no passRate", () => {
    expect(parseCiBadge(cap({ p95Ms: 50 })).status).toBe("unknown");
  });

  it("ignores an unrecognised status string and falls back to inference", () => {
    expect(parseCiBadge(cap({ status: "yellow" })).status).toBe("unknown");
    expect(parseCiBadge(cap({ status: "yellow", passRate: 1 })).status).toBe("green");
  });

  it("clamps passRate into 0..1", () => {
    expect(parseCiBadge(cap({ status: "green", passRate: 1.5 })).passRate).toBe(1);
    expect(parseCiBadge(cap({ status: "red", passRate: -0.2 })).passRate).toBe(0);
  });

  it("drops non-finite or invalid numeric fields", () => {
    const b = parseCiBadge(cap({ status: "green", passRate: Number.NaN, p95Ms: -5 }));
    expect(b.passRate).toBeUndefined();
    expect(b.p95Ms).toBeUndefined();
  });

  it("drops a non-string lastGreen", () => {
    expect(parseCiBadge(cap({ status: "green", lastGreen: 12345 })).lastGreen).toBeUndefined();
  });
});

describe("gateByCi", () => {
  it("allows unknown by default (advisory mode)", () => {
    const d = gateByCi({ capabilityId: "x" }, {});
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/advisory/i);
  });

  it("blocks unknown when requireGreen is set", () => {
    const d = gateByCi({ capabilityId: "x" }, { requireGreen: true });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/requireGreen/i);
  });

  it("blocks red even in advisory mode", () => {
    const d = gateByCi(cap({ status: "red" }), {});
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/red/i);
  });

  it("blocks red regardless of requireGreen", () => {
    expect(gateByCi(cap({ status: "red" }), { requireGreen: true }).allow).toBe(false);
  });

  it("allows green with requireGreen set", () => {
    const d = gateByCi(cap({ status: "green", passRate: 1 }), { requireGreen: true });
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/green/i);
  });

  it("blocks green when its passRate is below minPassRate", () => {
    const d = gateByCi(cap({ status: "green", passRate: 0.8 }), { minPassRate: 0.95 });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/0\.8.*0\.95|passRate/i);
  });

  it("allows green when passRate meets minPassRate", () => {
    expect(gateByCi(cap({ status: "green", passRate: 0.97 }), { minPassRate: 0.95 }).allow).toBe(true);
  });

  it("does not block green for minPassRate when no passRate is published", () => {
    expect(gateByCi(cap({ status: "green" }), { minPassRate: 0.95 }).allow).toBe(true);
  });

  it("does not block unknown via minPassRate (absence is not failure)", () => {
    const d = gateByCi({ capabilityId: "x" }, { minPassRate: 0.95 });
    expect(d.allow).toBe(true);
  });
});

describe("rankByCi", () => {
  it("orders green > unknown > red", () => {
    const red = cap({ status: "red" }, { capabilityId: "red" });
    const unknown = { capabilityId: "unknown" };
    const green = cap({ status: "green", passRate: 1 }, { capabilityId: "green" });
    const ranked = rankByCi([red, unknown, green]);
    expect(ranked.map((c) => c.capabilityId)).toEqual(["green", "unknown", "red"]);
  });

  it("within green, higher passRate ranks first", () => {
    const lo = cap({ status: "green", passRate: 0.9 }, { capabilityId: "lo" });
    const hi = cap({ status: "green", passRate: 1 }, { capabilityId: "hi" });
    const ranked = rankByCi([lo, hi]);
    expect(ranked.map((c) => c.capabilityId)).toEqual(["hi", "lo"]);
  });

  it("a green with a known passRate outranks a green with none", () => {
    const none = cap({ status: "green" }, { capabilityId: "none" });
    const known = cap({ status: "green", passRate: 0.5 }, { capabilityId: "known" });
    const ranked = rankByCi([none, known]);
    expect(ranked.map((c) => c.capabilityId)).toEqual(["known", "none"]);
  });

  it("is stable for equal keys (preserves input order)", () => {
    const a = cap({ status: "green", passRate: 1 }, { capabilityId: "a" });
    const b = cap({ status: "green", passRate: 1 }, { capabilityId: "b" });
    const c = cap({ status: "green", passRate: 1 }, { capabilityId: "c" });
    const ranked = rankByCi([a, b, c]);
    expect(ranked.map((x) => x.capabilityId)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const red = cap({ status: "red" }, { capabilityId: "red" });
    const green = cap({ status: "green", passRate: 1 }, { capabilityId: "green" });
    const input = [red, green];
    const ranked = rankByCi(input);
    expect(input.map((c) => c.capabilityId)).toEqual(["red", "green"]); // untouched
    expect(ranked.map((c) => c.capabilityId)).toEqual(["green", "red"]);
    expect(ranked).not.toBe(input);
  });

  it("handles an empty list", () => {
    expect(rankByCi([])).toEqual([]);
  });
});
