import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { HUDSON_PRODUCT as product, openHudsonCheckout } from "../src/checkout/hudson-browser.js";

const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.ARGUS_TEST_CHROMIUM_PATH || (existsSync(mac) ? mac : "");
const browserTest = it.runIf(Boolean(executablePath));
const browserHost = `ws://argus-hudson-browser:47871/${"a".repeat(64)}`;
const email = "fixture@example.invalid";
const web = "https://www.ridehudsonlink.com";
const api = "https://api.prod.coachusa.com";
const flex = "https://flex.cybersource.com";
const frame = `${flex}/microform/bundle/v2.0.2/iframe.html`;
const target = product.url.replace("travel-options", "travel-option") + "/0a8ec915";
const token = "eyHeader.eyToken.ValidSignature";
const orderId = "fixtureOrder123";
const billing = { name: "Fixture Buyer", street: "123 Fixture Street", city: "Fixture Town", state: "NY", postalCode: "10001", country: "US" };
const names = { firstName: "Fixture", lastName: "Buyer" };
const card = { number: "4242424242424242", cvv: "123", expMonth: "10", expYear: "2030" };
const cart = { ticketitems: [{ productId: product.productId, sod: "NCKW|TTWT", originStopId: "PALILJ", destinationStopId: "TARRYT",
  quantity: 1, fare: 2.75, ticketType: "ONE-WAY", passengerType: "ADULT", hasServiceFee: "N", serviceFeeList: [] }], reservations: [] };
const order = { customer: { email }, currency: "USD", lineItems: [{ productId: product.productId, sod: "NCKW|TTWT", quantity: 1,
  origin: { cityName: "West Nyack", stateCode: "NY", stopId: "PALILJ" },
  destination: { cityName: "Tarrytown", stateCode: "NY", stopId: "TARRYT" } }], reservations: [],
payments: [{ amount: 2.75, method: { transientTokenJwt: token,
  billingAddress: { firstName: names.firstName, lastName: names.lastName, address1: billing.street, locality: billing.city,
    administrativeArea: billing.state, postalCode: billing.postalCode, country: "US", countryCode: "US" },
  cardMetadata: { cardholderName: billing.name, cvv: "FROM_MICROFORM", last4: "4242", expirationMonth: "10", expirationYear: "30" } } }],
requestMetadata: { marketingOptIn: false } };
const ticket = { id: "abcd1234fixture", origin: { fareZone: { id: "NCKW" } }, destination: { fareZone: { id: "TTWT" } },
  operator: { code: "HSL" }, type: "ONE-WAY", passengerType: "ADULT", barcode: { value: "fixture-barcode" },
  validity: { isExpired: false }, redemptions: { isFullyRedeemed: false } };

const targetHtml = `<div>Adult $2.75<div><div><div><input aria-label="${product.productId}" value="0"></div><button data-testid="add_to_cart" aria-label="Add" style="width:20px;height:20px" onclick='document.querySelector("input").value="1";localStorage.setItem("cart_CUSA",${JSON.stringify(JSON.stringify(cart))})'></button></div></div></div>
<button onclick="this.hidden=true;drawer.hidden=false">Proceed to Checkout</button>
<div id="drawer" hidden><p>Total Price: $2.75</p><input id="email"><button onclick="location.href='/checkout'">Proceed to Checkout</button></div>`;

function checkoutHtml(mode: string): string {
  const body = structuredClone(order);
  if (mode === "changed") body.payments[0]!.amount = 4.99;
  return `<p>Amount Due: $2.75</p>
<input name="firstName"><input name="lastName"><input name="nameOnCard"><input autocomplete="cc-exp-month"><input autocomplete="cc-exp-year">
<div id="card-number"></div><div id="security-code"></div>
<button onclick="document.querySelector('#card-number iframe').contentWindow.postMessage('tokenize','${flex}')">Continue with card</button>
<div id="billing" hidden>
<input name="billingAddressLine1"><input name="cityTown"><input name="postalCode"><input name="email">
<button role="combobox" aria-label="Country">United States</button>
<button role="combobox" aria-label="State/Province" onclick="states.hidden=false">Select</button><div id="states" hidden><button role="option" data-value="NY" onclick="states.hidden=true">New York</button></div>
<label><input type="checkbox">I have read and agreed</label><button onclick="pay()">Pay $2.75</button>
</div><script>
async function load() {
  await fetch('${api}/payment/context',{method:'POST',headers:{'content-type':'application/json'}}).then(r=>r.json());
  for (const [i,id] of ['card-number','security-code'].entries()) {
    const f=document.createElement('iframe');f.title='secure payment field';f.src='${frame}?kind='+i;document.getElementById(id).append(f);
  }
}
window.addEventListener('message',e=>{if(e.origin==='${flex}'&&e.data==='token-ready')document.querySelector('#billing').hidden=false});
async function pay(){
  const a=await fetch('${api}/order',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.json());
  location.href='/tickets?order_id='+a.orderId;
}
load();</script>`;
}

function fixture(mode: "success" | "changed" | "unverified" | "conflict") {
  const journal = vi.fn();
  const sent: string[] = [];
  vi.spyOn(chromium, "connect").mockImplementation(async () => {
    const running = await chromium.launch({ executablePath, chromiumSandbox: true });
    const create = running.newContext.bind(running);
    vi.spyOn(running, "newContext").mockImplementation(async options => {
      const context = await create(options);
      const register = context.route.bind(context);
      vi.spyOn(context, "route").mockImplementation((pattern, handler, options) => register(pattern, async route => {
        vi.spyOn(route, "fetch").mockImplementation(async opts => {
          expect(opts?.maxRedirects).toBe(0);
          expect(opts?.maxRetries).toBe(0);
          const request = route.request();
          const url = request.url();
          const method = request.method();
          const reply = (body: string, type = "text/html", status = 200) => ({ status: () => status, ok: () => status < 300,
            headers: () => ({ "content-type": type, "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
              "access-control-allow-headers": "content-type" }), body: async () => Buffer.from(body), json: async () => JSON.parse(body),
            dispose: async () => {} }) as Awaited<ReturnType<typeof route.fetch>>;
          if (method === "OPTIONS") return reply("");
          if (method === "GET" && url === product.url) return reply(`<a role="button" href="${target}">Select Travel Option</a>`);
          if (method === "GET" && url === target) return reply(targetHtml);
          if (method === "GET" && url === `${web}/checkout`) return reply(checkoutHtml(mode));
          if (method === "POST" && url === `${api}/payment/context`) {
            const payload = Buffer.from(JSON.stringify({ flx: { origin: flex, path: "/flex/v2/tokens" } })).toString("base64url");
            return reply(JSON.stringify({ jwt: `eyHead.${payload}.Signature` }), "application/json");
          }
          if (method === "GET" && url.startsWith(`${frame}?kind=`)) return reply(`<input id="${url.endsWith('0') ? "number" : "securityCode"}">
<script>addEventListener('message',async(e)=>{if(e.origin!=='${web}')return;await fetch('${flex}/flex/v2/tokens', {method:'POST',headers:{'content-type':'application/jwt'},body:'head.key.iv.encrypted.tag'}).then(r=>r.text());parent.postMessage('token-ready','${web}')});</script>`);
          if (method === "POST" && url === `${flex}/flex/v2/tokens`) {
            sent.push("token");
            return reply(token, "text/plain");
          }
          if (method === "POST" && url === `${api}/order`) {
            expect(journal).toHaveBeenCalledOnce();
            sent.push("order");
            return reply(JSON.stringify({ orderId }), "application/json", 201);
          }
          if (method === "GET" && url === `${web}/tickets?order_id=${orderId}`) return reply(`<style>.print{display:none}@media print{.screen{display:none}.print{display:block}}</style>
<div class="screen"><canvas data-testid="ticket-canvas" aria-label="Boarding QR for Ticket Reference ABCD1234"></canvas></div>
<div class="print">Ticket Reference ABCD1234<canvas></canvas></div>
<script>fetch('${api}/order/${orderId}').then(r=>r.json()).then(()=>document.querySelectorAll('canvas').forEach(c=>c.getContext('2d').fillRect(0,0,20,20)));</script>`);
          if (method === "GET" && url === `${api}/order/${orderId}`) return reply(JSON.stringify({ orderId, tickets: [ticket],
            ...(mode === "unverified" ? {} : { currency: "USD", payments: [{ amount: mode === "conflict" ? 4.99 : 2.75 }] }) }), "application/json");
          throw new Error(`Unexpected ${method} fixture route`);
        });
        return handler(route);
      }, options));
      return context;
    });
    return running;
  });
  return { sent, journal };
}

afterEach(() => vi.restoreAllMocks());

browserTest.each(["success", "changed", "unverified", "conflict"] as const)("checks a %s Hudson Link payment without real network access", async mode => {
  const { sent, journal } = fixture(mode);
  const session = await openHudsonCheckout({ email, browserWsEndpoint: browserHost, signal: AbortSignal.timeout(12_000) });
  try {
    expect(session.totalCents).toBe(275);
    const result = session.complete(card, billing, names, journal, AbortSignal.timeout(8_000));
    if (mode === "success" || mode === "unverified") {
      const ticket = await result;
      expect(ticket.filename).toBe(product.filename);
      expect(Buffer.from(ticket.bytes).subarray(0, 5).toString()).toBe("%PDF-");
      expect(ticket.receiptVerified).toBe(mode === "success");
    } else if (mode === "changed") {
      await expect(result).rejects.toMatchObject({ submitted: false });
      expect(sent).toEqual(["token"]);
      expect(journal).not.toHaveBeenCalled();
      return;
    } else {
      await expect(result).rejects.toMatchObject({ code: "delivery_unconfirmed", submitted: true });
    }
    expect(journal).toHaveBeenCalledOnce();
    expect(sent).toEqual(["token", "order"]);
    await expect(session.complete(card, billing, names, journal)).rejects.toMatchObject({ submitted: true });
    expect(sent).toEqual(["token", "order"]);
  } finally {
    await session.close();
  }
}, 20_000);
