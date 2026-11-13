import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type APIResponse, type Browser, type BrowserContext, type Frame, type Locator, type Page, type Route } from "playwright-core";
import { MAX_ICON_ZIP_BYTES, validateIconZip } from "./zip.js";

export const ITCH_PRODUCT = Object.freeze({
  title: "Co-Working & Startup Office Icon Pack",
  merchant: "itch.io",
  productUrl: "https://aiimperium.itch.io/co-working-startup-office-icon-pack",
  filename: "Co_Working_Startup_Office_Icon_Pack.zip",
  baseCents: 299,
  maxCents: 500,
});

const PRODUCT = new URL(ITCH_PRODUCT.productUrl);
const PURCHASE = `${ITCH_PRODUCT.productUrl}/purchase`;
const TIMEOUT = 20_000;
const FRAME = '.stripe_elements_card iframe[src^="https://js.stripe.com/"]:visible';
const VERIFY = ['iframe[src*="/recaptcha/api2/bframe"]:visible', 'iframe[src*="hcaptcha"][title*="challenge" i]:visible',
  'iframe[src^="https://hooks.stripe.com/"]:visible', '.captcha:visible', 'iframe[src*="3ds"]:visible', 'iframe[src*="challenge"]:visible'].join(', ');
const CARD_BUTTON = 'button.pay_btn:visible';
const BILLING = '.billing_address_view:visible';
const VAT = '.vat_view:visible';
const PREPARE_REDIRECT = 'argus-itch-checkout-redirect';
const receiptPaid = /You purchased\b[^\n]*?\bfor\s+\$/i;

export interface ItchBilling {
  name: string;
  street: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface ItchCard {
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
}

interface Receipt {
  receiptCents: number;
  privateUrl: string;
}

interface Delivery {
  receiptCents: number;
  filename: string;
  bytes: Uint8Array;
}

export interface ItchCheckoutSession {
  totalCents: number;
  taxCents: number;
  complete(card: ItchCard, signal?: AbortSignal, onReceipt?: (receipt: Receipt) => Promise<void>, beforeSubmit?: () => void): Promise<Delivery>;
  close(): Promise<void>;
}

const messages = {
  billing_mismatch: "itch.io could not verify the billing address or tax location.",
  verification_required: "itch.io or Stripe requires interactive verification.",
  checkout_changed: "The expected itch.io item, checkout or final USD amount could not be verified.",
  checkout_redirected: "itch.io redirected to its homepage before presenting the payment form.",
  payment_unconfirmed: "The itch.io payment was submitted, but its result is unconfirmed. Reconcile it before retrying.",
  receipt_unconfirmed: "The exact paid itch.io receipt could not be verified.",
  download_failed: "The paid itch.io receipt was verified, but its expected ZIP could not be downloaded and validated.",
  cancelled: "The itch.io checkout was cancelled.",
} as const;

export class ItchCheckoutError extends Error {
  constructor(readonly code: keyof typeof messages, readonly submitted = false) {
    super(messages[code]);
    this.name = "ItchCheckoutError";
  }
}

function plainUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error("invalid URL");
  return url;
}

function checkoutUrl(value: string): URL {
  const url = plainUrl(value);
  const merchantPath = url.origin === PRODUCT.origin && (url.pathname === `${PRODUCT.pathname}/purchase` || url.pathname.startsWith(`${PRODUCT.pathname}/purchase/`));
  const platformPath = url.origin === "https://itch.io" && /^\/(?:checkout|purchase|stripe)(?:\/|$)/.test(url.pathname);
  if (!merchantPath && !platformPath) throw new Error("unexpected checkout URL");
  return url;
}

function receiptUrl(value: string): URL {
  const url = plainUrl(value);
  const path = url.pathname;
  const merchantReceipt = url.origin === PRODUCT.origin && path.startsWith(`${PRODUCT.pathname}/download/`)
    && /^[A-Za-z0-9_-]{8,160}\/?$/.test(path.slice(`${PRODUCT.pathname}/download/`.length));
  const platformReceipt = url.origin === "https://itch.io" && /^\/download\/[A-Za-z0-9_-]{8,160}\/?$/.test(path);
  if ((!merchantReceipt && !platformReceipt) || url.search) throw new Error("unexpected receipt URL");
  return url;
}

function usdCents(text: string): number {
  const match = /^\s*(?:(?:US\s*)?\$|USD\s*)\s*(\d{1,3})\.(\d{2})(?:\s*USD)?\s*$/i.exec(text);
  if (!match) throw new Error("invalid USD amount");
  return Number(match[1]) * 100 + Number(match[2]);
}

function verifyTotal(totalCents: number): number {
  if (totalCents < ITCH_PRODUCT.baseCents || totalCents > ITCH_PRODUCT.maxCents) throw new Error("unexpected total");
  return totalCents;
}

function merchantAsset(host: string): boolean {
  return [PRODUCT.hostname, "itch.io", "static.itch.io", "img.itch.zone", "img.itch.io"].includes(host);
}

function stripeAsset(host: string): boolean {
  return ["js.stripe.com", "api.stripe.com", "m.stripe.network", "m.stripe.com", "q.stripe.com", "r.stripe.com", "b.stripecdn.com"].includes(host);
}

function zipHost(host: string): boolean {
  return merchantAsset(host) || ["itchio.itch.io", "itchio-uploads.itch.zone", "itchio-upload-cdn.itch.zone", "itchio-uploads.s3.amazonaws.com", "itchio-production.s3.amazonaws.com"].includes(host);
}

interface BrowserOptions {
  executablePath?: string;
  browserWsEndpoint?: string;
}

export function isCheckoutBrowserEndpoint(value: string): boolean {
  return /^ws:\/\/argus-checkout-browser:47871\/[A-Za-z0-9_-]{32,128}$/.test(value);
}

async function isolatedBrowser({ executablePath, browserWsEndpoint }: BrowserOptions) {
  const browserHome = await mkdtemp(join(tmpdir(), "argus-itch-"));
  const env = { HOME: browserHome, TMPDIR: browserHome, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const cleanup = () => rm(browserHome, { recursive: true, force: true }).catch(() => {});
  let browser: Browser | undefined;
  try {
    if (browserWsEndpoint && !isCheckoutBrowserEndpoint(browserWsEndpoint)) throw new Error("unexpected checkout browser endpoint");
    const running = browserWsEndpoint
      ? await chromium.connect(browserWsEndpoint, { timeout: TIMEOUT })
      : await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env, timeout: TIMEOUT });
    browser = running;
    const context = await running.newContext({
      acceptDownloads: true, locale: "en-US", serviceWorkers: "block", bypassCSP: false,
    });
    const close = async () => {
      await context.close().catch(() => {});
      await running.close().catch(() => {});
      await cleanup();
    };
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    await context.routeWebSocket("**/*", socket => socket.close());
    return { close, context, page: await context.newPage() };
  } catch (error) {
    await browser?.close().catch(() => {});
    await cleanup();
    throw error;
  }
}

function stopOnAbort(signal: AbortSignal | undefined, close: () => Promise<void>): () => void {
  if (!signal) return () => {};
  const stop = () => { void close(); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return () => signal.removeEventListener("abort", stop);
}

function sanitize(error: unknown, fallback: keyof typeof messages, submitted: boolean, signal?: AbortSignal): ItchCheckoutError {
  if (error instanceof ItchCheckoutError) return error;
  return new ItchCheckoutError(signal?.aborted && !submitted ? "cancelled" : fallback, submitted);
}

async function checkVerification(page: Page, submitted = false): Promise<void> {
  if (await page.locator(VERIFY).count()) throw new ItchCheckoutError("verification_required", submitted);
}

async function rejectBillingErrors(page: Page): Promise<void> {
  if (await page.locator('.vat_view .on_vat_error:visible, .vat_view .on_generic_error:visible').first().isVisible()) {
    throw new ItchCheckoutError("billing_mismatch");
  }
}

async function paidAmount(form: Locator): Promise<number> {
  const text = await form.locator(CARD_BUTTON).innerText();
  return verifyTotal(usdCents(text.replace(/^\s*pay\s*/i, "")));
}

async function checkoutFields(form: Locator): Promise<string> {
  return await form.evaluate(node => {
    const BrowserFormData = FormData as unknown as new (form: unknown) => Iterable<[string, unknown]>;
    const data = new BrowserFormData(node);
    const fields = new URLSearchParams();
    for (const [name, value] of data) {
      if (typeof value !== "string" || fields.has(name)) throw new Error("unexpected checkout field");
      fields.append(name, value);
    }
    fields.sort();
    return fields.toString();
  });
}

async function stripeFrame(page: Page) {
  const iframe = page.locator(FRAME);
  await iframe.waitFor({ state: "visible" });
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("Stripe frame unavailable");
  await frame.locator('input[data-elements-stable-field-name="cardNumber"]:visible').waitFor({ state: "visible" });
  if (plainUrl(frame.url()).origin !== "https://js.stripe.com") throw new Error("Stripe frame origin changed");
  return frame;
}

async function fillStripe(frame: Frame, name: string, value: string): Promise<void> {
  if (plainUrl(frame.url()).origin !== "https://js.stripe.com") throw new Error("Stripe frame origin changed");
  const field = await frame.locator(`input[data-elements-stable-field-name="${name}"]:visible`).elementHandle();
  if (!field || plainUrl(frame.url()).origin !== "https://js.stripe.com") throw new Error("Stripe field unavailable");
  // An element handle is bound to this document and will fail if the frame navigates.
  await field.fill(value);
}

async function stripeForm(page: Page, email: string, billing: ItchBilling): Promise<Locator> {
  checkoutUrl(page.url());
  await checkVerification(page);
  await page.getByText(ITCH_PRODUCT.title, { exact: true }).first().waitFor({ state: "visible" });
  const form = page.locator("form").filter({ has: page.locator(CARD_BUTTON) });
  if (await form.count() !== 1) throw new Error("unexpected Stripe form");
  if (await form.locator('input[type="password"]:visible').count()) throw new ItchCheckoutError("verification_required");
  const input = form.locator('input[type="email"][name="email"]:visible');
  await input.fill(email);
  await form.locator('input[name="name"]:visible').fill(billing.name);
  const saved = form.locator('input[name="save_card"]');
  if (await saved.count() && await saved.isChecked()) throw new Error("unexpected saved-card option");
  await stripeFrame(page);
  return form;
}

async function prepareBilling(page: Page, email: string, billing: ItchBilling, advance: () => Promise<void>): Promise<number | undefined> {
  const form = page.locator('form.buy_form');
  const action = await form.getAttribute("action");
  if (!action || new URL(action, page.url()).href !== PURCHASE) throw new Error("purchase destination changed");
  const title = await page.locator('meta[property="og:title"]').getAttribute("content");
  if (title !== `Purchase ${ITCH_PRODUCT.title} by aiimperium`) throw new Error("product changed");
  await form.getByText(ITCH_PRODUCT.filename, { exact: true }).waitFor({ state: "visible" });
  const price = form.locator('input[name="price"]:visible');
  if (usdCents(await price.inputValue()) !== ITCH_PRODUCT.baseCents || await form.locator('input[name="gift"]').isChecked()) {
    throw new Error("unexpected purchase terms");
  }
  const rawSettings = await form.getAttribute("data-opts");
  const settings: unknown = JSON.parse(rawSettings ?? "{}");
  if (typeof settings !== "object" || !settings || Array.isArray(settings)) throw new Error("invalid checkout settings");
  const { collect_billing_address: collectBilling, collect_vat: collectVat } = settings as Record<string, unknown>;
  if ([collectBilling, collectVat].some(value => value !== undefined && typeof value !== "boolean")) {
    throw new Error("invalid checkout settings");
  }
  const hasAddressForm = await form.locator(".billing_address_view").count() > 0;
  if (!hasAddressForm && (collectBilling === true || collectVat === true)) throw new Error("billing form unavailable");
  await form.locator('input[name="email"]:visible').fill(email);
  await form.locator('button.checkout_stripe[data-source="stripe"]:visible').click();
  if (!hasAddressForm) {
    await page.locator(`${CARD_BUTTON}, ${VERIFY}, #${PREPARE_REDIRECT}`).first().waitFor({ state: "visible" });
    await advance();
    await checkVerification(page);
    return undefined;
  }
  const address = page.locator(BILLING);
  const fields = { name: billing.name, street_1: billing.street, street_2: billing.street2 ?? "",
    city: billing.city, state: billing.state, zip: billing.postalCode };
  await address.locator('select[name="address[country]"]:visible').selectOption({ label: /^US$/i.test(billing.country) ? "United States" : billing.country });
  for (const [field, value] of Object.entries(fields)) await address.locator(`input[name="address[${field}]"]:visible`).fill(value);
  await address.locator('button.save_billing_btn:visible').click();
  await page.locator(`${VAT}, ${CARD_BUTTON}, ${VERIFY}, #${PREPARE_REDIRECT}`).first().waitFor({ state: "visible" });
  await advance();
  await checkVerification(page);
  await rejectBillingErrors(page);
  if (!await page.locator(VAT).isVisible()) return undefined;
  const vat = page.locator(`${VAT} .on_vat_success:visible`);
  const subtotal = usdCents(await vat.locator('[data-field="product_price_formatted"]').innerText());
  const tax = usdCents(await vat.locator('[data-field="tax_formatted"]').innerText());
  const total = verifyTotal(usdCents(await vat.locator('[data-field="total_formatted"]').innerText()));
  if (subtotal !== ITCH_PRODUCT.baseCents || subtotal + tax !== total || await vat.locator('.tip_row:visible').count()) {
    throw new Error("tax or tip changed");
  }
  await vat.locator('button.confirm_vat_btn:visible').click();
  await page.locator(`${CARD_BUTTON}, ${VERIFY}, #${PREPARE_REDIRECT}`).first().waitFor({ state: "visible" });
  await advance();
  return total;
}

async function readReceipt(page: Page, expected?: number): Promise<Receipt> {
  const privateUrl = receiptUrl(page.url()).href;
  const heading = page.getByRole("heading", { name: new RegExp(ITCH_PRODUCT.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
  await heading.waitFor({ state: "visible" });
  if (new URL(privateUrl).origin !== PRODUCT.origin) {
    const productLinked = await page.locator("a[href]:visible, meta[property='og:url'][content]").evaluateAll((nodes, productUrl) => nodes.some(node => {
      const value = node.getAttribute("href") ?? node.getAttribute("content");
      if (!value) return false;
      try { return new URL(value, node.baseURI).href === productUrl; } catch { return false; }
    }), PRODUCT.href);
    if (!productLinked) throw new Error("receipt product URL changed");
  }
  const notice = page.getByText(receiptPaid).first();
  const text = await notice.innerText();
  const amounts = [...text.matchAll(/\$\d{1,3}\.\d{2}/g)].map(match => usdCents(match[0]));
  const separatedTax = /\$\d{1,3}\.\d{2}\s*\+\s*\$\d{1,3}\.\d{2}\s+(?:VAT|tax)\b/i.test(text);
  if (amounts.length !== (separatedTax ? 2 : 1)) throw new Error("receipt amount unavailable");
  const receiptCents = verifyTotal(amounts.reduce((sum, value) => sum + value, 0));
  if (expected !== undefined && receiptCents !== expected) throw new Error("receipt amount changed");
  return { privateUrl, receiptCents };
}

async function downloadZip(page: Page, receipt: Receipt): Promise<Delivery> {
  const item = page.locator('.upload, .upload_row, .download_row').filter({ has: page.getByText(ITCH_PRODUCT.filename, { exact: true }) });
  const button = item.locator('a.download_btn:visible, button.download_btn:visible');
  if (await button.count() !== 1) throw new Error("expected ZIP download is unavailable");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: TIMEOUT }), button.click()]);
  if (download.suggestedFilename() !== ITCH_PRODUCT.filename || !zipHost(plainUrl(download.url()).hostname)) {
    await download.cancel().catch(() => {});
    throw new Error("unexpected download");
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_ICON_ZIP_BYTES) throw new Error("ZIP exceeds limit");
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
    await download.delete().catch(() => {});
  }
  const bytes = Buffer.concat(chunks, size);
  validateIconZip(bytes);
  return { receiptCents: receipt.receiptCents, filename: ITCH_PRODUCT.filename, bytes };
}

async function receiptAccess(context: BrowserContext, receipt: URL): Promise<void> {
  await context.route("**/*", async route => {
    const request = route.request();
    let url: URL;
    try { url = plainUrl(request.url()); } catch { await route.abort(); return; }
    const downloadPath = url.pathname.startsWith(`${PRODUCT.pathname}/file/`) && /^\d+$/.test(url.pathname.slice(`${PRODUCT.pathname}/file/`.length));
    const platformFile = url.origin === "https://itch.io" && /^\/file\/\d+$/.test(url.pathname);
    const allowed = (request.method() === "GET" && (url.href === receipt.href || downloadPath && url.origin === PRODUCT.origin
      || platformFile || zipHost(url.hostname) && (url.origin !== receipt.origin || !request.isNavigationRequest())))
      || (request.method() === "POST" && (url.origin === PRODUCT.origin && downloadPath || platformFile));
    if (!allowed) return route.abort();
    return proxyRoute(route, context, "download").catch(() => route.abort().catch(() => {}));
  });
}

type RequestPurpose = "checkout" | "prepare" | "prepare-navigation" | "tokenize" | "charge" | "download";

function permittedCheckoutGet(url: URL): boolean {
  return merchantAsset(url.hostname) || stripeAsset(url.hostname);
}

async function fulfillResponse(route: Route, response: APIResponse, limit: number): Promise<void> {
  const headers: Record<string, string> = { ...response.headers(), "referrer-policy": "no-referrer" };
  const size = Number(headers["content-length"]);
  if (size > limit) throw new Error("response too large");
  const body = await response.body();
  if (body.byteLength > limit) throw new Error("response too large");
  delete headers["content-encoding"];
  delete headers["content-length"];
  await route.fulfill({ status: response.status(), headers, body });
}

async function proxyRoute(route: Route, context: BrowserContext, purpose: RequestPurpose, prepareRedirect?: (url: URL) => void): Promise<void> {
  const request = route.request();
  const url = plainUrl(request.url());
  const headers = { ...request.headers() };
  delete headers.referer;
  const response = await route.fetch({ headers, maxRedirects: 0, maxRetries: 0, timeout: TIMEOUT });
  try {
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers().location;
      if (!location || ![301, 302, 303, 307, 308].includes(status)) return route.abort();
      const redirect = plainUrl(new URL(location, url).href);
      if ((purpose === "prepare" || purpose === "prepare-navigation")
        && (status === 302 || status === 303) && redirect.href === "https://itch.io/") {
        throw new ItchCheckoutError("checkout_redirected");
      }
      if (purpose === "charge" && (status === 302 || status === 303)) {
        // The merchant's checkout script handles this field by navigating with a GET.
        return route.fulfill({ status: 200, json: { redirect_to: receiptUrl(redirect.href).href } });
      }
      if (purpose === "prepare" && (status === 302 || status === 303) && prepareRedirect) {
        // The final form defaults to the current URL. Use a new guarded navigation so
        // Chromium never automatically follows a redirect carrying the original POST.
        prepareRedirect(checkoutUrl(redirect.href));
        return route.fulfill({ contentType: "text/html", headers: { "referrer-policy": "no-referrer" },
          body: `<p id="${PREPARE_REDIRECT}">Continuing to checkout</p>` });
      }
      // Browser interceptors can miss later redirect hops. A permitted redirect is a single
      // controlled GET with no original method, body or Referer and no further redirects.
      const safeMethod = request.method() === "GET" || status === 302 || status === 303;
      const safeTarget = purpose === "download" ? zipHost(redirect.hostname)
        : purpose === "checkout" && permittedCheckoutGet(redirect);
      if (!safeMethod || !safeTarget) return route.abort();
      const targetHeaders = { ...headers };
      delete targetHeaders["content-length"];
      delete targetHeaders["content-type"];
      if (redirect.origin !== url.origin) {
        delete targetHeaders.authorization;
        delete targetHeaders.cookie;
        delete targetHeaders.origin;
      }
      const redirected = await context.request.get(redirect.href, { headers: targetHeaders, maxRedirects: 0, maxRetries: 0, timeout: TIMEOUT });
      try {
        if (redirected.status() >= 300 && redirected.status() < 400) return route.abort();
        return await fulfillResponse(route, redirected, purpose === "download" ? MAX_ICON_ZIP_BYTES : 8 * 1024 * 1024);
      } finally {
        await redirected.dispose().catch(() => {});
      }
    }
    await fulfillResponse(route, response, purpose === "download" ? MAX_ICON_ZIP_BYTES : 8 * 1024 * 1024);
  } finally {
    await response.dispose().catch(() => {});
  }
}

export async function openItchCheckout(options: BrowserOptions & { email: string; billing: ItchBilling; signal?: AbortSignal }): Promise<ItchCheckoutSession> {
  const { email, billing, signal } = options;
  if (signal?.aborted) throw new ItchCheckoutError("cancelled");
  const state = await isolatedBrowser(options).catch(() => { throw new ItchCheckoutError("checkout_changed"); });
  const { close, context, page } = state;
  const detach = stopOnAbort(signal, close);
  let submitted = false;
  let armed = false;
  let completeStarted = false;
  let approvedPost = "";
  let approvedFields = "";
  let submitHook: (() => void) | undefined;
  let completionSignal: AbortSignal | undefined;
  let paymentPostSent = false;
  let stripeTokenSent = false;
  let preparationPosted = false;
  let preparationRedirect: URL | undefined;
  let preparationFailure: ItchCheckoutError | undefined;
  let finishBeforeCharge = (_error: ItchCheckoutError) => {};
  const prechargeFailure = new Promise<ItchCheckoutError>(resolve => { finishBeforeCharge = resolve; });
  const stopPreparation = async (route: Route, error: unknown) => {
    if (error instanceof ItchCheckoutError && error.code === "checkout_redirected") {
      preparationFailure = error;
      await route.fulfill({ contentType: "text/html", headers: { "referrer-policy": "no-referrer" },
        body: `<p id="${PREPARE_REDIRECT}">Checkout unavailable</p>` }).catch(() => {});
      return;
    }
    await route.abort().catch(() => {});
  };
  const routeCheckout = async (route: Route) => {
    const request = route.request();
    let url: URL;
    try { url = plainUrl(request.url()); } catch { await route.abort(); return; }
    if (request.method() === "GET" && permittedCheckoutGet(url)) {
      const purpose = request.isNavigationRequest() && url.href === preparationRedirect?.href ? "prepare-navigation" : "checkout";
      return proxyRoute(route, context, purpose).catch(error => stopPreparation(route, error));
    }
    if (request.method() === "POST" && !armed && url.href === PURCHASE && !preparationPosted) {
      const fields = new URLSearchParams(request.postData() ?? "");
      if (fields.get("source") !== "stripe" || fields.get("email") !== email || fields.has("gift")
          || !/^(?:\$\s*|USD\s*)?2\.99$/.test(fields.get("price")?.trim() ?? "")
          || [...fields.keys()].some(name => /card|token/i.test(name) && name !== "csrf_token")) return route.abort();
      preparationPosted = true;
      return proxyRoute(route, context, "prepare", redirect => { preparationRedirect = redirect; }).catch(error => stopPreparation(route, error));
    }
    if (request.method() === "POST" && armed && url.origin === "https://api.stripe.com" && url.pathname === "/v1/tokens" && !stripeTokenSent) {
      stripeTokenSent = true;
      return proxyRoute(route, context, "tokenize").catch(() => route.abort().catch(() => {}));
    }
    if (request.method() === "POST" && armed && stripeTokenSent && url.href === approvedPost && !paymentPostSent) {
      const fields = new URLSearchParams(request.postData() ?? "");
      const tokens = fields.getAll("card_token");
      fields.delete("card_token");
      fields.sort();
      if (tokens.length !== 1 || !/^tok_[A-Za-z0-9_]+$/.test(tokens[0] ?? "") || fields.toString() !== approvedFields
          || !request.headers()["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
        finishBeforeCharge(new ItchCheckoutError("checkout_changed"));
        return route.abort();
      }
      try {
        if (signal?.aborted || completionSignal?.aborted) throw new ItchCheckoutError("cancelled");
        if (!submitHook) throw new ItchCheckoutError("checkout_changed");
        submitHook();
      } catch (error) {
        finishBeforeCharge(sanitize(error, "checkout_changed", false, completionSignal ?? signal));
        return route.abort();
      }
      paymentPostSent = true;
      submitted = true;
      return proxyRoute(route, context, "charge").catch(() => route.abort().catch(() => {}));
    }
    await route.abort();
  };
  try {
    await context.route("**/*", routeCheckout);
    const response = await page.goto(PURCHASE, { waitUntil: "domcontentloaded" });
    if (!response?.ok() || page.url() !== PURCHASE) throw new Error("purchase page unavailable");
    const vatTotal = await prepareBilling(page, email, billing, async () => {
      if (!await page.locator(`#${PREPARE_REDIRECT}`).isVisible()) return;
      if (preparationFailure) throw preparationFailure;
      const target = preparationRedirect;
      if (!target) throw new Error("checkout redirect unavailable");
      const redirected = await page.goto(target.href, { waitUntil: "domcontentloaded" });
      preparationRedirect = undefined;
      if (preparationFailure) throw preparationFailure;
      if (!redirected?.ok() || page.url() !== target.href) throw new Error("checkout redirect changed");
    });
    await page.locator(`${CARD_BUTTON}, ${VERIFY}`).first().waitFor({ state: "visible" });
    const form = await stripeForm(page, email, billing);
    const totalCents = await paidAmount(form);
    if (totalCents !== (vatTotal ?? ITCH_PRODUCT.baseCents)) throw new Error("checkout total changed after tax preview");
    const paymentPage = checkoutUrl(page.url());
    const action = await form.getAttribute("action");
    approvedPost = checkoutUrl(action ? new URL(action, paymentPage).href : paymentPage.href).href;
    return {
      totalCents, taxCents: totalCents - ITCH_PRODUCT.baseCents,
      close: async () => { detach(); await close(); },
      async complete(card, completeSignal, onReceipt, beforeSubmit) {
        if (completeStarted) throw new ItchCheckoutError(submitted ? "payment_unconfirmed" : "checkout_changed", submitted);
        completeStarted = true;
        completionSignal = completeSignal;
        const detachComplete = stopOnAbort(completeSignal, close);
        try {
          if (!beforeSubmit) throw new ItchCheckoutError("checkout_changed");
          await checkVerification(page);
          if (signal?.aborted || completeSignal?.aborted) throw new ItchCheckoutError("cancelled");
          if (page.url() !== paymentPage.href || await paidAmount(form) !== totalCents) throw new Error("checkout changed");
          if (!/^\d{13,19}$/.test(card.number) || !/^(?:0?[1-9]|1[0-2])$/.test(card.expMonth)
              || !/^(?:20)?\d{2}$/.test(card.expYear) || !/^\d{3,4}$/.test(card.cvv)) throw new Error("invalid card inputs");
          const stripe = await stripeFrame(page);
          await fillStripe(stripe, "cardNumber", card.number);
          await fillStripe(stripe, "cardExpiry", card.expMonth.padStart(2, "0") + card.expYear.slice(-2));
          await fillStripe(stripe, "cardCvc", card.cvv);
          const postal = stripe.locator('input[data-elements-stable-field-name="postalCode"]:visible');
          if (await postal.count()) await fillStripe(stripe, "postalCode", billing.postalCode);
          await checkVerification(page);
          if (page.url() !== paymentPage.href || await paidAmount(form) !== totalCents || await form.locator('input[name="email"]').inputValue() !== email) {
            throw new Error("checkout changed after card entry");
          }
          approvedFields = await checkoutFields(form);
          const fields = new URLSearchParams(approvedFields);
          if (fields.get("email") !== email || fields.get("name") !== billing.name || fields.has("card_token")
              || !fields.get("csrf_token") || [...fields.keys()].some(name => /price|amount|tax|tip|total|currency|gift|save_card/i.test(name))) {
            throw new Error("unexpected checkout fields");
          }
          if (signal?.aborted || completeSignal?.aborted) throw new ItchCheckoutError("cancelled");
          submitHook = beforeSubmit;
          armed = true;
          await form.locator(CARD_BUTTON).click();
          await Promise.race([
            page.waitForURL(url => { try { return !!receiptUrl(url.href); } catch { return false; } }, { timeout: TIMEOUT }),
            prechargeFailure.then(error => { throw error; }),
            page.locator(VERIFY).first().waitFor({ state: "visible", timeout: TIMEOUT }).then(() => { throw new ItchCheckoutError("verification_required", submitted); }),
          ]);
          if (!paymentPostSent) throw new Error("no payment request");
          const receipt = await readReceipt(page, totalCents).catch(() => { throw new ItchCheckoutError("receipt_unconfirmed", true); });
          await onReceipt?.(receipt);
          await receiptAccess(context, receiptUrl(receipt.privateUrl));
          await context.unroute("**/*", routeCheckout);
          return await downloadZip(page, receipt).catch(() => { throw new ItchCheckoutError("download_failed", true); });
        } catch (error) {
          throw sanitize(error, submitted ? "payment_unconfirmed" : "checkout_changed", submitted, completeSignal ?? signal);
        } finally {
          detachComplete();
          detach();
          await close();
        }
      },
    };
  } catch (error) {
    detach();
    await close();
    throw sanitize(error, "checkout_changed", false, signal);
  }
}

export async function resumeItchDownload(options: BrowserOptions & { privateUrl: string; signal?: AbortSignal }): Promise<Delivery> {
  const { signal } = options;
  if (signal?.aborted) throw new ItchCheckoutError("cancelled");
  let url: URL;
  try { url = receiptUrl(options.privateUrl); }
  catch { throw new ItchCheckoutError("receipt_unconfirmed"); }
  const { close, context, page } = await isolatedBrowser(options).catch(() => { throw new ItchCheckoutError("download_failed"); });
  const detach = stopOnAbort(signal, close);
  try {
    await receiptAccess(context, url);
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
    if (!response?.ok() || page.url() !== url.href) throw new ItchCheckoutError("receipt_unconfirmed");
    const receipt = await readReceipt(page).catch(() => { throw new ItchCheckoutError("receipt_unconfirmed"); });
    return await downloadZip(page, receipt);
  } catch (error) {
    throw sanitize(error, "download_failed", false, signal);
  } finally {
    detach();
    await close();
  }
}
