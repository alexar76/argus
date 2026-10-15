import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentKey,
  canonicalize,
  issueMandate,
  mandateDigest,
  MandateCredential,
  publicKeyOfDid,
  requestMessage,
  requestProof,
  signDocument,
  verifyDocument,
} from "../src/economy/aimarket-mandate.js";
import { AimarketConsumer } from "../src/economy/aimarket.js";
import { verify } from "node:crypto";

// The protocol's normative vectors, signed by the AWR/2 reference implementation (Python).
const VECTORS = join(__dirname, "..", "..", "aimarket-protocol", "test-vectors", "mandate-signed.json");
const haveVectors = existsSync(VECTORS);
const V = haveVectors ? JSON.parse(readFileSync(VECTORS, "utf8")) : null;

describe.runIf(haveVectors)("normative vectors (aimarket-protocol/mandates.md §9)", () => {
  it("derives the same did:key from each seed", () => {
    for (const name of ["owner", "agent", "delegate"]) {
      expect(AgentKey.fromSeedHex(V.keys[name].seed_hex).did).toBe(V.keys[name].did);
    }
  });

  it("signs the reference documents byte for byte and names them by the same digest", () => {
    for (const [name, issuer] of [["root", "owner"], ["child", "agent"]] as const) {
      const expected = V[name].document;
      const { proof, ...unsigned } = expected;
      const rebuilt = signDocument(unsigned, AgentKey.fromSeedHex(V.keys[issuer].seed_hex), proof.created);
      expect(rebuilt).toEqual(expected);
      expect(canonicalize(rebuilt)).toBe(canonicalize(expected));
      expect(mandateDigest(rebuilt)).toBe(V[name].digest);
      expect(verifyDocument(rebuilt)).toBe(true);
    }
  });

  it("reproduces the request proof", () => {
    const p = V.request_proof;
    const header = requestProof(AgentKey.fromSeedHex(V.keys.delegate.seed_hex), {
      hubOrigin: V.hub_origin, leafDigest: p.leaf, body: p.body, t: p.t, nonce: p.n,
    });
    expect(header).toBe(p.header);
    expect(requestMessage({ hubOrigin: V.hub_origin, method: "POST", path: p.path, digest: p.leaf, t: p.t, nonce: p.n, body: p.body }))
      .toBe(p.message);
  });
});

describe("canonical JSON", () => {
  it("orders keys by UTF-16 code units and refuses non-integers", () => {
    expect(canonicalize({ b: 1, a: [true, null, "é"], "€": 2, "😀": 3 })).toBe('{"a":[true,null,"é"],"b":1,"€":2,"😀":3}');
    expect(() => canonicalize({ perCall: 0.5 })).toThrow(/integers/);
    expect(() => canonicalize({ s: "\ud800" })).toThrow(/surrogate/);
  });
});

describe("issuing and delegating", () => {
  it("issues a verifiable mandate in µUSD and re-delegates by digest", () => {
    const owner = AgentKey.generate();
    const argus = AgentKey.generate();
    const sub = AgentKey.generate();
    const root = issueMandate(owner, argus.did, {
      audience: ["https://modelmarket.dev/"], scope: ["gaia.*"], perCallUsd: 0.02, perDayUsd: 1, subcontractAllowanceUsd: 0.005,
    });
    const body = (root.credentialSubject as any).aimarketMandate;
    expect(body.limits).toEqual({ perCall: 20_000, perDay: 1_000_000 });
    expect(body.audience).toEqual(["https://modelmarket.dev"]);
    expect(body.subcontract).toEqual({ perCallAllowance: 5_000, maxDepth: 1 });
    expect(verifyDocument(root)).toBe(true);
    const child = issueMandate(argus, sub.did, { audience: body.audience, scope: ["gaia.weather.read@v1"], perCallUsd: 0.01, perDayUsd: 0.1, parent: root });
    expect((child.credentialSubject as any).aimarketMandate.parent).toBe(mandateDigest(root));
    (root.credentialSubject as any).aimarketMandate.limits.perDay = 10 ** 9;
    expect(verifyDocument(root)).toBe(false);
  });

  it("refuses a mandate issued to another key", () => {
    const owner = AgentKey.generate();
    const doc = issueMandate(owner, AgentKey.generate().did, { audience: ["https://h.test"], scope: ["*"], perCallUsd: 0.01, perDayUsd: 0.1 });
    expect(() => new MandateCredential(doc, AgentKey.generate(), "https://h.test")).toThrow(/issued to/);
  });
});

describe("paying with a mandate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends one signed POST: no channel, no wallet, the proof over the exact body", async () => {
    const owner = AgentKey.generate();
    const argus = AgentKey.generate();
    const doc = issueMandate(owner, argus.did, { audience: ["https://h.test"], scope: ["*"], perCallUsd: 0.01, perDayUsd: 0.1 });
    const mandate = new MandateCredential(doc, argus, "https://h.test");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, result: { t: 11 }, price_usd: 0.001, latency_ms: 40 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return log; } } as any;
    const consumer = new AimarketConsumer({
      hubUrl: "https://h.test", walletKey: "", mandate, affiliate: "argus", verifyTee: false, verifyOutputs: false,
      defaultDepositUsd: 1, minHubTrust: 0, token: "USDC", chain: "base", log,
    });
    const out = await consumer.invoke("gaia.weather.read@v1", { device_id: "om-wx-01" }, { productId: "gaia.gateway", sourceHub: "https://iot.test" });
    expect(out).toMatchObject({ ok: true, priceUsd: 0.001, output: { t: 11 } });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://h.test/ai-market/v2/invoke");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-AIMarket-Mandate"]).toBe(mandate.digest);
    expect(headers["X-Payment-Channel"]).toBeUndefined();
    const [t, n, s] = headers["X-AIMarket-Mandate-Proof"]!.split(";").map((part) => part.split("=").slice(1).join("="));
    const message = requestMessage({ hubOrigin: "https://h.test", method: "POST", path: "/ai-market/v2/invoke", digest: mandate.digest, t: Number(t), nonce: n!, body: String(init.body) });
    expect(verify(null, Buffer.from(message), publicKeyOfDid(argus.did), Buffer.from(s!, "base64url"))).toBe(true);
    expect(JSON.parse(String(init.body))).toMatchObject({ capability_id: "gaia.weather.read@v1", product_id: "gaia.gateway", source_hub: "https://iot.test" });
  });

  it("reports a limit refusal as the hub's code, not an exception", async () => {
    const owner = AgentKey.generate();
    const argus = AgentKey.generate();
    const mandate = new MandateCredential(
      issueMandate(owner, argus.did, { audience: ["https://h.test"], scope: ["*"], perCallUsd: 0.01, perDayUsd: 0.1 }), argus, "https://h.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, error: "mandate_limit", limit: "perDay" }), {
      status: 402, headers: { "content-type": "application/json" },
    })));
    const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return log; } } as any;
    const consumer = new AimarketConsumer({
      hubUrl: "https://h.test", walletKey: "", mandate, affiliate: "argus", verifyTee: false, verifyOutputs: false,
      defaultDepositUsd: 1, minHubTrust: 0, token: "USDC", chain: "base", log,
    });
    expect(await consumer.invoke("x@v1", {})).toMatchObject({ ok: false, error: "mandate_limit:perDay" });
  });
});

describe("configuration", () => {
  it("turns the economy on with a mandate alone — no wallet, crypto off", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-mandate-"));
    const argus = AgentKey.generate();
    const doc = issueMandate(AgentKey.generate(), argus.did, { audience: ["https://h.test"], scope: ["*"], perCallUsd: 0.01, perDayUsd: 0.1 });
    const file = join(dir, "mandate.json");
    writeFileSync(file, JSON.stringify(doc));
    const saved = { ...process.env };
    try {
      process.env.ARGUS_MANDATE_FILE = file;
      process.env.ARGUS_AGENT_KEY = argus.seedHex();
      delete process.env.ARGUS_WALLET_KEY;
      process.env.ARGUS_CRYPTO_ENABLED = "0";
      process.env.AIFACTORY_CRYPTO_ENABLED = "0";
      process.env.ARGUS_STATE_DIR = dir;
      // "test" mode builds no chain context and touches no network (runtime.ts).
      process.env.ARGUS_MODE = "test";
      const { loadConfig } = await import("../src/config.js");
      const { Runtime } = await import("../src/runtime.js");
      const { config } = loadConfig(join(dir, "none.json"));
      expect(config.economy.enabled).toBe(true);
      const rt = await Runtime.create(config, { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } } as any);
      expect(rt.paymentRail).toBe("mandate");
      expect(rt.mandate()!.digest).toBe(mandateDigest(doc));
      await rt.dispose();
    } finally {
      process.env = saved;
    }
  });
});
