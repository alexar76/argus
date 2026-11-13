import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { ITCH_PRODUCT as p, openItchCheckout, resumeItchDownload, ItchCheckoutError } from "../src/checkout/itch-browser.js";

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.ARGUS_TEST_CHROMIUM_PATH || (existsSync(macChrome) ? macChrome : "");
const browserTest = it.runIf(Boolean(executablePath));
const launch = chromium.launch.bind(chromium);
afterEach(() => vi.restoreAllMocks());

const purchase=p.productUrl+"/purchase";
const receipt=p.productUrl+"/download/FixtureReceipT9876";
const dl=p.productUrl+"/file/111";
const pay=p.productUrl+"/purchase/stripe";
const stripe="https://js.stripe.com/v3/fixture.html";
const billing={name:"Fixture Holder",street:"100 Fixture Drive",city:"San Diego",state:"CA",postalCode:"92101",country:"US"};
const card={number:"4242424242424242",expMonth:"12",expYear:"2030",cvv:"123"};
const email="checkout@example.invalid";
const zip = Buffer.from("UEsDBBQAAAAIADRybV2/w4ETPwAAAEYAAAAQAAAAZml4dHVyZS9pY29uLnBuZ+sM8HPn5ZLiYmBg4PX0cAkC0owgzMEGJOVFj3SCJVwcQyrmJCckJPzgZ2BkYWSIf3rYGyjB4Onq57LOKaEJAFBLAQIUAxQAAAAIADRybV2/w4ETPwAAAEYAAAAQAAAAAAAAAAAAAACAAQAAAABmaXh0dXJlL2ljb24ucG5nUEsFBgAAAAABAAEAPgAAAG0AAAAAAA==", "base64");
const receiptHtml=`<h1>${p.title}</h1><p>You purchased the game for $2.99 + $0.24 VAT with the email fixture. This page has a unique URL for your purchase.</p><div class="upload"><strong>${p.filename}</strong><a class="download_btn" href="${dl}">Download</a></div>`;
const stripeHtml=`<input data-elements-stable-field-name="cardNumber"><input data-elements-stable-field-name="cardExpiry"><input data-elements-stable-field-name="cardCvc"><input data-elements-stable-field-name="postalCode">`;
const directPreflight = `<meta property="og:title" content="Purchase Co-Working &amp; Startup Office Icon Pack by aiimperium">
<form class="buy_form" action="${purchase}" method="post" data-opts='{"logged_in":false}'>
<strong>${p.filename}</strong><input type="hidden" name="source" value=""><input name="price" value="$2.99">
<input name="gift" type="checkbox"><input name="email" type="email">
<button class="checkout_stripe" type="submit" data-source="stripe" onclick="this.form.elements.source.value=this.dataset.source">Card</button>
</form>`;
const preflight=(mode)=>`<meta property="og:title" content="Purchase Co-Working &amp; Startup Office Icon Pack by aiimperium"><form class="buy_form" action="${purchase}" method="post">
<strong>${p.filename}</strong><input type="hidden" name="source" value="stripe"><input name="price" value="$2.99"><input name="gift" type="checkbox"><input name="email" type="email"><button class="checkout_stripe" type="button" data-source="stripe" onclick="document.querySelector('.billing_address_view').hidden=false">Card</button>
<div class="billing_address_view" hidden><input name="address[name]"><input name="address[street_1]"><input name="address[street_2]"><input name="address[city]"><input name="address[state]"><input name="address[zip]"><select name="address[country]"><option value="United States">United States</option></select><button class="save_billing_btn" type="button" onclick="document.querySelector('.billing_address_view').hidden=true;document.querySelector('.vat_view').hidden=false">Continue payment</button></div>
<div class="vat_view" hidden>${mode==="billing" ? '<p class="on_vat_error">Country mismatch</p>' : '<div class="on_vat_success"><span data-field="product_price_formatted">$2.99</span><span data-field="tax_formatted">$0.24</span><span data-field="total_formatted">$3.23</span><button class="confirm_vat_btn" type="submit">Continue payment</button></div>'}</div></form>`;
const payment=(mode)=>`<h1>${p.title}</h1><form action="${pay}" onsubmit="charge(event)"><input type="hidden" name="csrf_token" value="fixture_csrf"><input type="hidden" name="tz" value="0">
<input name="email" type="email"><input name="name" type="text"><div class="stripe_elements_card"><iframe src="${stripe}"></iframe></div>
<button class="pay_btn" type="submit">Pay ${mode==="wrong_amount" ? "$3.24" : mode === "direct" ? "$2.99" : "$3.23"}</button></form><script>
async function charge(event){event.preventDefault(); const token=await fetch("https://api.stripe.com/v1/tokens",{method:"POST",body:new URLSearchParams({fixture:"only"})}).then(r=>r.json());
const fields=new URLSearchParams(new FormData(event.target)); fields.set("card_token",token.id); ${mode === "mutated" ? 'fields.set("email", "wrong@example.invalid");' : ""} const reply=await fetch("${pay}",{method:"POST",body:fields}).then(r=>r.json());location=reply.redirect_to;}
</script>`;

function checkoutFixture(mode: string) {
  const requests: string[] = [];
  const journal = { count: 0 };
  vi.spyOn(chromium, "launch").mockImplementation(async options => {
    expect(options?.chromiumSandbox).toBe(true);
    expect(Object.keys(options?.env ?? {}).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
    const browser = await launch(options);
    const create = browser.newContext.bind(browser);
    vi.spyOn(browser, "newContext").mockImplementation(async options => {
      const context = await create(options);
      const attach = context.route.bind(context);
      // Only responses manufactured here may leave the interceptor; no actual API request runs.
      vi.spyOn(context.request, "get").mockRejectedValue(new Error("Unexpected redirected fixture fetch"));
      vi.spyOn(context, "route").mockImplementation((pattern, handler, options) => attach(pattern, async route => {
        vi.spyOn(route, "fetch").mockImplementation(async options => {
          const request = route.request();
          const url = request.url();
          const method = request.method();
          requests.push(`${method} ${url}`);
          expect(options?.maxRedirects).toBe(0);
          expect(options?.maxRetries).toBe(0);
          expect(options?.headers?.referer).toBeUndefined();
          const reply = (body: string | Buffer, headers: Record<string, string> = {}, status = 200) => ({
            status: () => status, headers: () => headers, body: async () => Buffer.from(body), dispose: async () => {},
          }) as Awaited<ReturnType<typeof route.fetch>>;
          const html = (body: string) => reply(body, {"content-type": "text/html"});
          if (url === purchase && method === "GET") return html(mode === "direct" ? directPreflight : preflight(mode));
          if (url === purchase && method === "POST") {
            if (mode === "unsafe_redirect") return reply("", {location: "https://unrelated.example/charge"}, 307);
            return reply("", {location: pay}, 303);
          }
          if (url === pay && method === "GET") {
            if (mode === "chained_redirect") return reply("", {location: "https://unrelated.example/charge"}, 302);
            if (mode === "vendor_root") return reply("", {location: "https://itch.io/"}, 302);
            expect(request.postData()).toBeNull();
            return html(payment(mode));
          }
          if (url === stripe) return html(stripeHtml);
          if (url === "https://api.stripe.com/v1/tokens" && method === "POST") {
            expect(journal.count).toBe(0);
            return reply('{"id":"tok_Fixture123"}', {"content-type": "application/json", "access-control-allow-origin": new URL(pay).origin});
          }
          if (url === pay && method === "POST") {
            expect(journal.count).toBe(1);
            return reply("", {location: receipt}, 303);
          }
          if (url === receipt && method === "GET") return html(receiptHtml);
          if (url === dl && method === "GET") return reply(zip, {"content-type": "application/zip",
            "content-disposition": `attachment; filename="${p.filename}"`});
          throw new Error("Unexpected fixture fetch");
        });
        return handler(route);
      }, options));
      return context;
    });
    return browser;
  });
  return { requests, journal, options: { billing, email, executablePath, signal: AbortSignal.timeout(8_000) } };
}

browserTest.each([
  ["billing", "billing_mismatch"], ["wrong_amount", "checkout_changed"], ["unsafe_redirect", "cancelled"],
  ["chained_redirect", "checkout_changed"], ["vendor_root", "checkout_redirected"],
])("stops %s before any fixture charge", async (mode, code) => {
  const { requests, options } = checkoutFixture(mode);
  await assert.rejects(openItchCheckout(options), e => e instanceof ItchCheckoutError && e.code === code && !e.submitted);
  expect(requests).not.toContain(`POST ${pay}`);
  expect(requests).not.toContain("GET https://itch.io/");
  expect(requests.some(url => url.includes("unrelated.example"))).toBe(false);
}, 15_000);

browserTest.each(["journal", "mutated"])("rejects %s before merchant submission", async mode => {
  const { requests, options, journal } = checkoutFixture(mode);
  const session = await openItchCheckout(options);
  try {
    await assert.rejects(session.complete(card, undefined, undefined, () => {
      if (mode === "journal") throw new Error("synthetic private journal error");
      journal.count++;
    }), e => e instanceof ItchCheckoutError && !e.submitted && !e.message.includes("synthetic private"));
    expect(journal.count).toBe(0);
    expect(requests).not.toContain(`POST ${pay}`);
  } finally { await session.close(); }
}, 15_000);

browserTest("opens the direct card checkout when itch.io omits billing and VAT", async () => {
  const { requests, options } = checkoutFixture("direct");
  const session = await openItchCheckout(options);
  try {
    expect({ total: session.totalCents, tax: session.taxCents }).toEqual({ total: 299, tax: 0 });
    expect(requests.filter(request => request === `POST ${purchase}`)).toHaveLength(1);
    expect(requests).not.toContain(`POST ${pay}`);
  } finally { await session.close(); }
}, 15_000);

browserTest("submits one fixture charge, verifies the receipt and recovers the exact ZIP without repaying", async () => {
  const { requests, options, journal } = checkoutFixture("success");
  const session = await openItchCheckout(options);
  expect({ total: session.totalCents, tax: session.taxCents }).toEqual({ total: 323, tax: 24 });
  try {
    const saved = vi.fn(async () => {});
    const result = await session.complete(card, undefined, saved, () => { journal.count++; });
    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith({ receiptCents: 323, privateUrl: receipt });
    expect(result).toEqual({ receiptCents: 323, filename: p.filename, bytes: zip });
    await assert.rejects(session.complete(card), e => e instanceof ItchCheckoutError && e.submitted);
    expect(await resumeItchDownload({ privateUrl: receipt, executablePath })).toEqual(result);
    expect(requests.filter(request => request === `GET ${pay}`)).toHaveLength(1);
    expect(requests.filter(request => request === `POST ${pay}`)).toHaveLength(1);
  } finally { await session.close(); }
}, 15_000);

it("rejects a receipt URL on an unrelated seller before opening Chromium", async () => {
  await assert.rejects(resumeItchDownload({privateUrl:"https://other.itch.io/download/FixtureReceipT9876"}),
    e => e instanceof ItchCheckoutError && e.code === "receipt_unconfirmed");
});
