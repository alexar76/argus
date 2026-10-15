// ARGUS buys a travel eSIM for its owner (tools/esim.ts, economy/esim.ts) from a seller that answers
// like the eSIM operator kit's node: 402 with x402 terms, then the delivery; status; refund.
// The test seller is in this file so the suite stays self-contained.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildEsimTools } from "../src/tools/esim.js";
import { EsimClient, sellerUrl } from "../src/economy/esim.js";
import { request } from "node:http";
import { setOwnerSink, type OwnerNote } from "../src/channels/owner-notify.js";
import type { Tool } from "../src/types.js";

const LPA = "LPA:1$rsp-eu.example.com$SECRET-MATCHING-ID";
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as any;

interface Seen { paid: any[]; refunds: number; installed: boolean }

function seller(seen: Seen, priceUnits = "310000", demo = false): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const offer = { offer_id: "TR_0.1_7", name: "Turkey 100MB 7Days", coverage: { kind: "country", countries: ["TR"] },
                    data_gb: 0.1, days: 7, price: { usd: (Number(priceUnits) / 1e6).toFixed(2), currency: "USDC" } };
    if (req.url === "/quote") return json(200, { success: true, result: { seller: { name: demo ? "demo seller" : "test seller", demo }, offers: [offer], order: { url: `${url}/order` } } });
    if (req.url === "/order") {
      const sig = req.headers["payment-signature"];
      const terms = { scheme: "exact", network: "eip155:8453", amount: priceUnits, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                      payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
      if (!sig) {
        const required = { x402Version: 2, error: "Payment required", resource: { url: `${url}/order` }, accepts: [terms] };
        return json(402, {}, { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") });
      }
      seen.paid.push(JSON.parse(Buffer.from(String(sig), "base64").toString("utf8")));
      return json(200, { success: true, result: {
        order_no: "B1", esim_tran_no: "26101500000001", iccid: "8988000000000000001", activation_code: LPA,
        qr_code_url: "https://qr.example/1.png", install_url: "https://install.example/1", apn: "internet", expires: null,
        status_token: "tok-1", offer, receipt: { v: 1, kind: "delivery", nonce: "0xnonce" }, receipt_signature: "sig-delivery" } },
        { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "ee".repeat(32) })).toString("base64") });
    }
    if (req.url === "/status") return json(200, { success: true, result: { esim_tran_no: "26101500000001", state: "GOT_RESOURCE",
      installed: seen.installed, data_used_bytes: 0, activation_code: LPA, status_token: "tok-1" } });
    if (req.url === "/refund") {
      if (seen.installed) return json(409, { success: false, error: "in_use", message: "installed" });
      seen.refunds++;
      return json(200, { success: true, result: { esim_tran_no: "26101500000001", status: "refunded", amount_usd: "0.31",
        to: seen.paid[0]?.payload?.authorization?.from, transaction: "0x" + "ff".repeat(32),
        receipt: { v: 1, kind: "refund" }, receipt_signature: "sig-refund" } });
    }
    return json(404, { success: false });
  });
  let url = "";
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    url = `http://127.0.0.1:${(server.address() as any).port}`;
    resolve({ url, server });
  }));
}

describe("ARGUS buys an eSIM for its owner", () => {
  let seen: Seen;
  let srv: { url: string; server: Server };
  let notes: OwnerNote[];
  let stateDir: string;
  let tools: Record<string, Tool>;
  const key = generatePrivateKey();

  beforeEach(async () => {
    seen = { paid: [], refunds: 0, installed: false };
    srv = await seller(seen);
    notes = [];
    setOwnerSink(async (n) => { notes.push(n); });
    stateDir = mkdtempSync(join(tmpdir(), "argus-esim-"));
    tools = Object.fromEntries(buildEsimTools({ seller: srv.url, hubs: [], maxUsd: 1, walletKey: () => key, stateDir, log: quiet }).map((t) => [t.def.name, t]));
  });
  afterEach(async () => {
    setOwnerSink(null);
    await new Promise((r) => srv.server.close(r));
  });

  it("asks for approval by name: buy and refund match the owner's approval patterns, the reads do not", () => {
    expect(Object.keys(tools)).toEqual(["esim_offers", "esim_buy", "esim_status", "esim_refund"]);
    const patterns = ["*buy*", "*refund*"];
    const sensitive = (n: string) => patterns.some((p) => new RegExp(`^${p.replace(/\*/g, ".*")}$`).test(n));
    expect(Object.keys(tools).filter(sensitive)).toEqual(["esim_buy", "esim_refund"]);
  });

  it("quotes, then pays exactly the asked price from its wallet; the eSIM goes to the owner, never to the model", async () => {
    const offers = await tools.esim_offers.run({ country: "tr" }, { log: quiet });
    expect(offers.content).toContain("TR_0.1_7");
    expect((await tools.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet })).content).toContain("[blocked]");
    expect(seen.paid).toHaveLength(0);

    const bought = await tools.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true });   // after esim_offers above
    expect(bought.ok).toBe(true);
    const auth = seen.paid[0].payload.authorization;
    expect(auth.from).toBe(privateKeyToAccount(key).address);
    expect(auth.to).toBe("0x1111111111111111111111111111111111111111");
    expect(auth.value).toBe("310000");
    // the owner got the QR, the code to copy and the transaction; the model got none of the secret
    expect(notes[0].photoUrl).toBe("https://qr.example/1.png");
    expect(notes[0].copyable).toBe(LPA);
    expect(notes[0].text).toContain("0x" + "ee".repeat(32));
    expect(bought.content).not.toContain("SECRET-MATCHING-ID");
    expect(JSON.stringify(bought.data)).not.toContain("SECRET-MATCHING-ID");
    // nor the ledger, which is the owner's file only
    const ledger = join(stateDir, "esim-purchases.json");
    expect(readFileSync(ledger, "utf8")).not.toContain("SECRET-MATCHING-ID");
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    const status = await tools.esim_status.run({}, { log: quiet });
    expect(status.content).toContain("GOT_RESOURCE");
    expect(status.content).not.toContain("SECRET-MATCHING-ID");
  });

  it("refunds the latest purchase with the owner's approval, and says so in the owner's chat", async () => {
    await tools.esim_offers.run({ country: "TR" }, { log: quiet });
    await tools.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true });
    expect((await tools.esim_refund.run({}, { log: quiet })).content).toContain("[blocked]");
    const r = await tools.esim_refund.run({}, { log: quiet, approved: true });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Refunded 0.31 USDC");
    expect(r.content).toContain("0x" + "ff".repeat(32));
    expect(seen.refunds).toBe(1);
    expect(notes.at(-1)?.text).toContain("Refunded");
    expect(new EsimClient(stateDir).find()?.refund?.status).toBe("refunded");
  });

  it("an installed eSIM is not refunded; a price above the cap is never signed", async () => {
    await tools.esim_offers.run({ country: "TR" }, { log: quiet });
    await tools.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true });
    seen.installed = true;
    const r = await tools.esim_refund.run({}, { log: quiet, approved: true });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("in_use");

    const dear: Seen = { paid: [], refunds: 0, installed: false };
    const pricey = await seller(dear, "2500000");
    try {
      const t = buildEsimTools({ seller: pricey.url, hubs: [], maxUsd: 1, walletKey: () => key, stateDir, log: quiet });
      await t[0].run({ country: "TR" }, { log: quiet });
      const res = await t[1].run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true });
      expect(res.ok).toBe(false);
      expect(dear.paid).toHaveLength(0);
    } finally {
      await new Promise((r) => pricey.server.close(r));
    }
  });

  it("a seller is https, or http on this machine", () => {
    expect(sellerUrl("https://esim.example.com/agents/")).toBe("https://esim.example.com/agents");
    expect(sellerUrl("http://127.0.0.1:9489")).toBe("http://127.0.0.1:9489");
    expect(() => sellerUrl("http://esim.example.com")).toThrow(/https/);
  });
});

// A hub as modelmarket.dev answers: /search lists each seller's esim.quote@v1, /invoke relays a quote
// and wraps the seller's answer. Its sellers here: one in DEMO mode (cheaper), one that sells.
function hub(sellers: Array<{ url: string; product: string }>): Promise<{ url: string; server: Server; invokes: string[]; shared: any[] }> {
  const invokes: string[] = [];
  const shared: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = (status: number, obj: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url?.startsWith("/ai-market/v2/search")) {
      return json(200, { matches: [
        ...sellers.flatMap((s) => [
          { capability_id: "esim.quote@v1", product_id: s.product, source_hub: s.url, source_hub_name: s.product, route_status: "live" },
          { capability_id: "esim.status@v1", product_id: s.product, source_hub: s.url, source_hub_name: s.product, route_status: "live" },
        ]),
        { capability_id: "gaia.weather.read@v1", product_id: "gaia", source_hub: "https://iot.example", route_status: "live" },
      ] });
    }
    if (req.url === "/ai-market/v2/reputation/deliveries") {
      shared.push(JSON.parse(body));
      return json(200, { recorded: true, deliveries_30d: { confirmed: shared.length } });
    }
    if (req.url === "/ai-market/v2/invoke") {
      const b = JSON.parse(body);
      invokes.push(`${b.capability_id} ${b.product_id}`);
      const s = sellers.find((x) => x.product === b.product_id);
      if (!s) return json(404, { detail: "unknown" });
      const answer = await new Promise<any>((ok) => {
        const r = request(`${s.url}/quote`, { method: "POST", headers: { "content-type": "application/json" } }, async (rs) => {
          let t = ""; for await (const c of rs) t += c; ok(JSON.parse(t));
        });
        r.end(JSON.stringify(b.input));
      });
      return json(200, { success: true, result: answer, price_usd: 0, routed_via: "hub" });
    }
    return json(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, server, invokes, shared })));
}

describe("ARGUS finds eSIM sellers through a hub", () => {
  it("quotes every seller the hub lists, marks the DEMO one, and pays only the one that sells, at its own /order", async () => {
    const key = generatePrivateKey();
    const real: Seen = { paid: [], refunds: 0, installed: false };
    const demoSeen: Seen = { paid: [], refunds: 0, installed: false };
    const realSrv = await seller(real, "310000");
    const demoSrv = await seller(demoSeen, "200000", true);
    const h = await hub([{ url: demoSrv.url, product: "esim-demo" }, { url: realSrv.url, product: "esim-real" }]);
    const notes: OwnerNote[] = [];
    setOwnerSink(async (n) => { notes.push(n); });
    try {
      const stateDir = mkdtempSync(join(tmpdir(), "argus-esim-hub-"));
      const t = Object.fromEntries(buildEsimTools({ seller: "", hubs: [h.url], maxUsd: 1, walletKey: () => key, stateDir, log: quiet }).map((x) => [x.def.name, x]));
      const offers = await t.esim_offers.run({ country: "TR" }, { log: quiet });
      expect(h.invokes).toEqual(["esim.quote@v1 esim-demo", "esim.quote@v1 esim-real"]);   // quotes only, through the hub
      expect(offers.content).toContain("1 offer(s) you can buy");
      expect(offers.content).toMatch(/\[SELLS\] TR_0\.1_7 .* 0\.31 USDC — seller "test seller"\n\[DEMO: sells nothing\] TR_0\.1_7 .* 0\.20 USDC — seller "demo seller"/);
      const bought = await t.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true });
      expect(bought.ok).toBe(true);
      expect(real.paid).toHaveLength(1);
      expect(demoSeen.paid).toHaveLength(0);
      expect(new EsimClient(stateDir).find()?.seller).toBe(realSrv.url);   // status and refund go to the seller that sold
      // the seller's signed receipt and the transaction go to the hub that listed the seller
      await new Promise((r) => setTimeout(r, 100));
      expect(h.shared).toEqual([{ receipt: { v: 1, kind: "delivery", nonce: "0xnonce" }, signature: "sig-delivery", transaction: "0x" + "ee".repeat(32) }]);
      const refunded = await t.esim_refund.run({}, { log: quiet, approved: true });
      expect(refunded.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.shared[1]).toEqual({ receipt: { v: 1, kind: "refund" }, signature: "sig-refund", transaction: "0x" + "ff".repeat(32) });
      expect(new EsimClient(stateDir).find()?.shared).toEqual({ [`delivery@${h.url}`]: "recorded", [`refund@${h.url}`]: "recorded" });
    } finally {
      setOwnerSink(null);
      await Promise.all([realSrv, demoSrv, h].map((x) => new Promise((r) => x.server.close(r))));
    }
  });

  it("when only DEMO sellers answer, it says nothing can be bought, and esim_buy refuses", async () => {
    const demoSeen: Seen = { paid: [], refunds: 0, installed: false };
    const demoSrv = await seller(demoSeen, "200000", true);
    const h = await hub([{ url: demoSrv.url, product: "esim-demo" }]);
    try {
      const t = Object.fromEntries(buildEsimTools({ seller: "", hubs: [h.url], maxUsd: 1, walletKey: () => generatePrivateKey(), stateDir: mkdtempSync(join(tmpdir(), "argus-esim-hub-")), log: quiet }).map((x) => [x.def.name, x]));
      expect((await t.esim_offers.run({ country: "TR" }, { log: quiet })).content).toContain("Only DEMO sellers answered");
      const r = await t.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true });
      expect(r.ok).toBe(false);
      expect(r.content).toContain("only by a DEMO seller");
      expect(demoSeen.paid).toHaveLength(0);
    } finally {
      await Promise.all([demoSrv, h].map((x) => new Promise((r) => x.server.close(r))));
    }
  });
});

describe("the owner can keep ARGUS's purchases to itself", () => {
  it("with ARGUS_SHARE_DELIVERIES=0 no receipt leaves ARGUS", async () => {
    const real: Seen = { paid: [], refunds: 0, installed: false };
    const realSrv = await seller(real, "310000");
    const h = await hub([{ url: realSrv.url, product: "esim-real" }]);
    try {
      const t = Object.fromEntries(buildEsimTools({ seller: "", hubs: [h.url], shareDeliveries: false, maxUsd: 1, walletKey: () => generatePrivateKey(), stateDir: mkdtempSync(join(tmpdir(), "argus-esim-private-")), log: quiet }).map((x) => [x.def.name, x]));
      await t.esim_offers.run({ country: "TR" }, { log: quiet });
      expect((await t.esim_buy.run({ offer_id: "TR_0.1_7" }, { log: quiet, approved: true })).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.shared).toEqual([]);
    } finally {
      await Promise.all([realSrv, h].map((x) => new Promise((r) => x.server.close(r))));
    }
  });
});

