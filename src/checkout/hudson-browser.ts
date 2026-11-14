import { chromium, type APIResponse, type BrowserContext, type ElementHandle, type Frame, type Page, type Request, type Route } from "playwright-core";
import type { ItchBilling, ItchCard } from "./itch-browser.js";

const WEB = "https://www.ridehudsonlink.com";
const API = "https://api.prod.coachusa.com";
const FLEX = "https://flex.cybersource.com";
const UNIFIED = "https://up.cybersource.com";
const LEGACY_API = "https://a1wn4tvuv7.execute-api.us-east-1.amazonaws.com";
const SLUGS = "palisades-center-lot-j-west-nyack-ny/depot-plz-train-station-tarrytown-ny";
const OFFER = `/travel-options/${SLUGS}`;
const PRODUCT = `/travel-option/${SLUGS}/0a8ec915`;
const FLEX_ASSETS = "/microform/bundle/v2.0.2/";
const FLEX_FRAME = `${FLEX}${FLEX_ASSETS}iframe.html`;
const CONTEXT = `${API}/payment/context`;
const ORDER = `${API}/order`;
const PRICE = 2.75;
const TIMEOUT = 18_000;
const TOKEN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/;
const ENCRYPTED = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}$/;
const ORDER_ID = /^[a-zA-Z0-9_-]{8,120}$/;
const CAPTCHA = 'iframe[src*="/recaptcha/api2/bframe"]:visible, iframe[src*="hcaptcha"][title*="challenge" i]:visible, iframe[src*="challenge" i]:visible, iframe[src*="3ds" i]:visible';
const UNIFIED_CONTEXT = {
  platform: "unified-checkout-v1",
  transaction: { currency: "USD", amount: PRICE },
  captureMandate: { billingType: "FULL", requestEmail: true, requestPhone: false, requestShipping: false, showAcceptedNetworkIcons: true },
};

export const HUDSON_PRODUCT = Object.freeze({
  title: "Hudson Link Adult Single Ride",
  merchant: "Hudson Link",
  origin: "Palisades Center (lot J), West Nyack, NY",
  destination: "Depot Plaza (train station), Tarrytown, NY",
  productId: "HSL2032601",
  route: "H07",
  url: `${WEB}${OFFER}`,
  totalCents: 275,
  filename: "Hudson-Link-Ticket.pdf",
} as const);

const message = {
  offer_changed: "The exact Hudson Link adult fare or checkout total could not be verified.",
  checkout_unavailable: "Hudson Link did not present the verified guest card checkout.",
  verification_required: "Hudson Link or its payment provider requires interactive verification.",
  payment_unconfirmed: "Hudson Link received the payment request, but the order outcome is unconfirmed. Reconcile before retrying.",
  delivery_unconfirmed: "The Hudson Link order was confirmed, but the printable ticket was not verified.",
  cancelled: "The Hudson Link checkout was cancelled.",
} as const;

export class HudsonCheckoutError extends Error {
  constructor(readonly code: keyof typeof message, readonly submitted = false) {
    super(message[code]);
    this.name = "HudsonCheckoutError";
  }
}

export interface HudsonCheckoutSession {
  totalCents: typeof HUDSON_PRODUCT.totalCents;
  complete(card: ItchCard, billing: ItchBilling, traveler: { firstName: string; lastName: string },
    beforeSubmit: () => void | Promise<void>, signal?: AbortSignal): Promise<{
      totalCents: typeof HUDSON_PRODUCT.totalCents;
      filename: typeof HUDSON_PRODUCT.filename;
      bytes: Uint8Array;
      receiptVerified: boolean;
    }>;
  close(): Promise<void>;
}

interface Purchase {
  billing: ItchBilling;
  traveler: { firstName: string; lastName: string };
  cardholder: { expMonth: string; expYear: string; last4: string };
  beforeSubmit: () => void | Promise<void>;
  signal?: AbortSignal;
}

interface Gate {
  checkout: boolean;
  cardFields: boolean;
  tokenUrl?: string;
  token?: string;
  tokenStarted: boolean;
  purchase?: Purchase;
  submitted: boolean;
  orderId?: string;
  verifiedTicketReference?: string;
  receiptVerified: boolean;
  receiptConflict: boolean;
  deniedPayment: boolean;
}

export function isHudsonBrowserEndpoint(value: string): boolean {
  return /^ws:\/\/argus-hudson-browser:47871\/[A-Za-z0-9_-]{32,128}$/.test(value);
}

function sameKeys(value: unknown, model: unknown): boolean {
  if (value === model) return true;
  if (value === null || model === null || typeof value !== "object" || typeof model !== "object") return false;
  if (Array.isArray(value) !== Array.isArray(model)) return false;
  const actual = value as Record<string, unknown>;
  const expected = model as Record<string, unknown>;
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => Object.hasOwn(actual, key) && sameKeys(actual[key], item));
}

function href(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) return url;
  } catch {}
  return undefined;
}

function fromFrame(request: Request, page: Page, url: string): boolean {
  try {
    const frame = request.frame();
    return url === `${WEB}/checkout` ? frame === page.mainFrame() && frame.url() === url
      : href(frame.url())?.origin === FLEX && href(frame.url())?.pathname === new URL(url).pathname
        && frame.parentFrame() === page.mainFrame() && page.url() === `${WEB}/checkout`;
  } catch {
    return false;
  }
}

function safeRead(url: URL, request: Request, gate: Gate): boolean {
  const { origin, pathname, search } = url;
  if (origin === WEB) {
    if (pathname === OFFER || pathname === PRODUCT || pathname === "/checkout") return !search || /^\?date=\d{4}-\d{2}-\d{2}$/.test(search);
    if (pathname === "/tickets") return Boolean(gate.orderId && search === `?order_id=${gate.orderId}`);
    if (/^\/_next\/data\/[A-Za-z0-9_-]{10,50}\/(?:en\/)?/.test(pathname)) {
      return pathname.endsWith(`${PRODUCT}.json`) || gate.checkout && pathname.endsWith("/checkout.json")
        || Boolean(gate.orderId && pathname.endsWith("/tickets.json") && search === `?order_id=${gate.orderId}`);
    }
    return !search && /^\/(?:_next\/static|images|svg|logos|fonts)\//.test(pathname)
      && /\.(?:js|css|woff2?|svg|png|webp|ico)$/.test(pathname) && !request.isNavigationRequest();
  }
  if (origin === API) {
    return pathname === "/origin/NCKW/destination/TTWT/fare" && /^\?operatorCode=HSL&serviceUuid=0a8ec915&date=\d{4}-\d{2}-\d{2}$/.test(search)
      || gate.checkout && !search && !request.isNavigationRequest() && (pathname === "/countries" || pathname === "/countries/US/states")
      || Boolean(gate.orderId && !search && pathname === `/order/${gate.orderId}`);
  }
  if (origin === LEGACY_API) return pathname === "/prod/fare/farerules" && search === "?from=we"
    || pathname === "/prod/order/translation/en-us" && !search;
  if (origin === FLEX && gate.checkout) {
    return pathname === `${FLEX_ASSETS}iframe.html` || !search && ["flex-microform.min.js", "iframe.min.js", "iframe.css"]
      .map(file => FLEX_ASSETS + file).includes(pathname);
  }
  return origin === UNIFIED && gate.checkout && !search
    && /^\/uc\/v1\/assets\/[A-Za-z0-9_-]{30,220}\/[A-Za-z0-9_.-]{1,120}\.(?:js|css|html|svg|woff2?)$/.test(pathname);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requestJson(request: Request): Record<string, unknown> | undefined {
  const body = request.postData();
  if (!body || body.length > 16_384 || !request.headers()["content-type"]?.startsWith("application/json")) return;
  try { return jsonObject(JSON.parse(body)); } catch { return undefined; }
}

function ticketReference(value: unknown): string | undefined {
  const order = jsonObject(value);
  if (!Array.isArray(order?.tickets) || order.tickets.length !== 1 || Array.isArray(order.reservations) && order.reservations.length) return;
  const ticket = jsonObject(order.tickets[0]);
  const origin = jsonObject(jsonObject(ticket?.origin)?.fareZone);
  const destination = jsonObject(jsonObject(ticket?.destination)?.fareZone);
  const operator = jsonObject(ticket?.operator);
  const barcode = jsonObject(ticket?.barcode);
  const validity = jsonObject(ticket?.validity);
  const redemptions = jsonObject(ticket?.redemptions);
  if (origin?.id !== "NCKW" || destination?.id !== "TTWT" || operator?.code !== "HSL"
    || ticket?.type !== "ONE-WAY" || !/^ADULT$/i.test(String(ticket.passengerType))
    || validity?.isExpired !== false || redemptions?.isFullyRedeemed !== false
    || typeof barcode?.value !== "string" || barcode.value.length === 0
    || typeof ticket.id !== "string" || !ORDER_ID.test(ticket.id)) return;
  return ticket.id.substring(0, 8).toUpperCase();
}

function financialReceipt(value: unknown, orderId: string): "missing" | "verified" | "conflict" {
  const order = jsonObject(value);
  if (!order) return "missing";
  const id = order.orderId ?? order.id;
  if (id != null && id !== orderId || order.currency != null && order.currency !== "USD"
    || order.totalAmount != null && order.totalAmount !== PRICE) return "conflict";
  if (order.payments != null && (!Array.isArray(order.payments) || order.payments.length !== 1)) return "conflict";
  const payment = Array.isArray(order.payments) ? jsonObject(order.payments[0]) : undefined;
  if (payment?.amount != null && payment.amount !== PRICE) return "conflict";
  return order.currency === "USD" && (payment?.amount === PRICE || order.totalAmount === PRICE) ? "verified" : "missing";
}

function verifyReceipt(gate: Gate, value: unknown, orderId: string): void {
  const status = financialReceipt(value, orderId);
  if (status === "conflict") gate.receiptConflict = true;
  else if (status === "verified") gate.receiptVerified = true;
}

function orderMatches(request: Request, email: string, purchase: Purchase, token: string): boolean {
  const order = requestJson(request);
  if (!order || !Object.keys(order).every(key => ["customer", "currency", "lineItems", "reservations", "payments", "requestMetadata"].includes(key))) return false;
  if (order.currency !== "USD" || !sameKeys(order.customer, { email }) || !sameKeys(order.reservations, [])) return false;
  if (!sameKeys(order.lineItems, [{ productId: HUDSON_PRODUCT.productId, sod: "NCKW|TTWT", quantity: 1,
    origin: { cityName: "West Nyack", stateCode: "NY", stopId: "PALILJ" },
    destination: { cityName: "Tarrytown", stateCode: "NY", stopId: "TARRYT" } }])) return false;
  if (!Array.isArray(order.payments) || order.payments.length !== 1) return false;
  const payment = jsonObject(order.payments[0]);
  const method = jsonObject(payment?.method);
  const address = jsonObject(method?.billingAddress);
  const card = jsonObject(method?.cardMetadata);
  const context = jsonObject(order.requestMetadata);
  const { billing, traveler, cardholder } = purchase;
  return Boolean(payment?.amount === PRICE && Object.keys(payment).length === 2 && method?.transientTokenJwt === token
    && Object.keys(method).every(key => ["paymentInstrumentId", "billingAddress", "cardMetadata", "transientTokenJwt"].includes(key))
    && (method.paymentInstrumentId == null || method.paymentInstrumentId === "")
    && address?.firstName === traveler.firstName && address?.lastName === traveler.lastName
    && address?.address1 === billing.street && (address.address2 ?? "") === (billing.street2 ?? "")
    && address?.locality === billing.city && address?.administrativeArea === billing.state && address?.postalCode === billing.postalCode
    && address?.country === "US" && address?.countryCode === "US" && !address.phoneNumber
    && Object.keys(address).every(key => ["firstName", "lastName", "address1", "address2", "locality", "administrativeArea",
      "postalCode", "country", "countryCode", "countryPhoneCode", "phoneNumber"].includes(key))
    && card?.cardholderName === billing.name && card?.last4 === cardholder.last4 && card?.cvv === "FROM_MICROFORM"
    && card?.expirationMonth === cardholder.expMonth && card?.expirationYear === cardholder.expYear.slice(-2)
    && Object.keys(card).every(key => ["cardType", "cardholderName", "bin", "last4", "expirationMonth", "expirationYear", "cvv"].includes(key))
    && context?.marketingOptIn === false
    && Object.keys(context).every(key => ["sessionId", "channel", "source", "marketingOptIn"].includes(key)));
}

async function fulfill(route: Route, response: APIResponse): Promise<void> {
  const headers = { ...response.headers(), "referrer-policy": "strict-origin" } as Record<string, string>;
  const limit = 8 * 1024 * 1024;
  if (Number(headers["content-length"]) > limit) throw new Error("oversized checkout response");
  const body = await response.body();
  if (body.length > limit) throw new Error("oversized checkout response");
  delete headers["content-length"];
  delete headers["content-encoding"];
  await route.fulfill({ status: response.status(), headers, body });
}

function rememberCapture(gate: Gate, response: unknown): void {
  const jwt = jsonObject(response)?.jwt;
  if (typeof jwt !== "string" || jwt.length > 32_768 || !TOKEN.test(jwt)) return;
  try {
    const body = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
    const url = href(`${body.flx?.origin ?? ""}${body.flx?.path ?? ""}`);
    if (url?.origin === FLEX && url.pathname === "/flex/v2/tokens" && !url.search && !url.hash) gate.tokenUrl = url.href;
  } catch {}
}

async function intercept(route: Route, page: Page, gate: Gate, email: string): Promise<void> {
  const request = route.request();
  const url = href(request.url());
  if (!url) return route.abort();
  const method = request.method();
  const checkoutFrame = fromFrame(request, page, `${WEB}/checkout`);
  const secureFrame = fromFrame(request, page, FLEX_FRAME);
  const context = gate.checkout && url.href === CONTEXT && checkoutFrame;
  const token = gate.cardFields && url.href === gate.tokenUrl && secureFrame;
  const order = gate.purchase && url.href === ORDER && checkoutFrame;
  const data = request.postData();
  let contextCapture = false;
  let tokenCapture = false;
  let orderCapture = false;
  if (method === "GET") {
    if (data !== null || !safeRead(url, request, gate)) return route.abort();
  } else if (method === "OPTIONS") {
    if (data !== null || !context && !token && !order) return route.abort();
  } else if (method === "POST" && context && (!data || sameKeys(requestJson(request), UNIFIED_CONTEXT))) {
    contextCapture = !data;
  } else if (method === "POST" && token && !gate.tokenStarted && typeof data === "string" && data.length <= 16_384
      && ENCRYPTED.test(data) && request.headers()["content-type"]?.startsWith("application/jwt")) {
    gate.tokenStarted = true;
    tokenCapture = true;
  } else if (method === "POST" && url.href === ORDER) {
    if (!order || !gate.purchase || gate.submitted || gate.deniedPayment || gate.purchase.signal?.aborted
      || !gate.token || !orderMatches(request, email, gate.purchase, gate.token)) {
      gate.deniedPayment = true;
      return route.abort();
    }
    gate.submitted = true;
    try {
      await gate.purchase.beforeSubmit();
    } catch {
      gate.submitted = false;
      gate.deniedPayment = true;
      return route.abort();
    }
    orderCapture = true;
  } else {
    return route.abort();
  }

  try {
    const headers = { ...request.headers() };
    if (headers.referer) {
      const referer = href(headers.referer);
      if (referer) headers.referer = `${referer.origin}/`;
      else delete headers.referer;
    }
    const response = await route.fetch({ headers, maxRedirects: 0, maxRetries: 0, timeout: TIMEOUT });
    try {
      if (response.status() >= 300 && response.status() < 400) return await route.abort();
      if (response.ok() && contextCapture) rememberCapture(gate, await response.json());
      if (response.ok() && tokenCapture) {
        const transient = (await response.body()).toString("utf8");
        if (transient.length > 12_000 || !TOKEN.test(transient)) return await route.abort();
        gate.token = transient;
      }
      if (response.ok() && orderCapture) {
        const data = await response.json();
        const id = jsonObject(data)?.orderId;
        if (typeof id === "string" && ORDER_ID.test(id)) {
          gate.orderId = id;
          verifyReceipt(gate, data, id);
        }
      }
      if (response.ok() && method === "GET" && gate.orderId && url.href === `${ORDER}/${gate.orderId}`) {
        const data = await response.json();
        gate.verifiedTicketReference = ticketReference(data);
        verifyReceipt(gate, data, gate.orderId);
      }
      await fulfill(route, response);
    } finally { await response.dispose(); }
  } catch {
    await route.abort().catch(() => {});
  }
}

async function verification(page: Page, gate: Gate): Promise<void> {
  if (await page.locator(CAPTCHA).count()) throw new HudsonCheckoutError("verification_required", gate.submitted);
}

async function total(page: Page, text: "cart" | "checkout"): Promise<void> {
  const label = text === "cart" ? /^Total Price:\s*\$2\.75$/ : /^Amount Due:\s*\$2\.75$/;
  await page.getByText(label).filter({ visible: true }).first().waitFor({ state: "visible" }).catch(() => {
    throw new HudsonCheckoutError("offer_changed");
  });
}

async function exactCart(page: Page): Promise<void> {
  const correct = await page.evaluate(() => {
    try {
      const cart = JSON.parse(localStorage.getItem("cart_CUSA") ?? "null");
      if (cart?.ticketitems?.length !== 1 || (cart.reservations?.length ?? 0) !== 0) return false;
      const t = cart.ticketitems[0];
      return t.productId === "HSL2032601" && t.sod === "NCKW|TTWT" && t.originStopId === "PALILJ"
        && t.destinationStopId === "TARRYT" && t.quantity === 1 && t.fare === 2.75 && t.ticketType === "ONE-WAY"
        && t.passengerType === "ADULT" && t.hasServiceFee === "N" && t.serviceFeeList?.length === 0;
    } catch {
      return false;
    }
  });
  if (!correct) throw new HudsonCheckoutError("offer_changed");
}

function isVerifiedFieldFrame(page: Page, frame: Frame): boolean {
  const url = href(frame.url());
  return url?.origin === FLEX && url.pathname === `${FLEX_ASSETS}iframe.html` && frame.parentFrame() === page.mainFrame()
    && page.url() === `${WEB}/checkout`;
}

async function secureField(page: Page, wrapper: string, input: string): Promise<{ frame: Frame; field: ElementHandle }> {
  const frameLocator = page.locator(`${wrapper} iframe[title="secure payment field"]:visible`);
  await frameLocator.waitFor({ state: "visible" });
  const frame = await (await frameLocator.elementHandle())?.contentFrame();
  if (!frame) throw new HudsonCheckoutError("checkout_unavailable");
  const field = await frame.locator(input).elementHandle();
  if (!field || !await field.isVisible() || !isVerifiedFieldFrame(page, frame)) {
    throw new HudsonCheckoutError("checkout_unavailable");
  }
  return { frame, field };
}

async function prepare(page: Page, gate: Gate, email: string): Promise<void> {
  const response = await page.goto(HUDSON_PRODUCT.url, { waitUntil: "domcontentloaded" });
  if (response?.status() !== 200 || page.url() !== HUDSON_PRODUCT.url) throw new HudsonCheckoutError("checkout_unavailable");
  await page.getByRole("button", { name: "Select Travel Option", exact: true }).first().click();
  const quantity = page.locator(`input[aria-label="${HUDSON_PRODUCT.productId}"]:visible`);
  await quantity.waitFor({ state: "visible" });
  if (href(page.url())?.pathname !== PRODUCT || await quantity.count() !== 1 || await quantity.inputValue() !== "0") {
    throw new HudsonCheckoutError("offer_changed");
  }
  const row = quantity.locator("../../../..");
  if ((await row.innerText()).trim().replace(/\s+/g, " ") !== "Adult $2.75") throw new HudsonCheckoutError("offer_changed");
  await row.getByTestId("add_to_cart").click();
  if (await quantity.inputValue() !== "1") throw new HudsonCheckoutError("offer_changed");
  await exactCart(page);
  const proceed = page.getByRole("button", { name: "Proceed to Checkout", exact: true });
  await proceed.first().click();
  await total(page, "cart");
  await page.locator("input#email:visible").fill(email);
  gate.checkout = true;
  await proceed.last().click();
  await page.waitForURL(`${WEB}/checkout`);
  await total(page, "checkout");
  await verification(page, gate);
  await exactCart(page);
  await secureField(page, "#card-number", "input#number");
  await secureField(page, "#security-code", "input#securityCode");
  if (!gate.tokenUrl) throw new HudsonCheckoutError("checkout_unavailable");
}

async function fillBilling(page: Page, billing: ItchBilling, email: string): Promise<void> {
  await page.locator('input[name="billingAddressLine1"]:visible').fill(billing.street);
  if (billing.street2) await page.locator('input[name="billingAddressLine2"]:visible').fill(billing.street2);
  const country = page.getByRole("combobox", { name: /Country/i });
  if (!/United States/.test(await country.innerText())) {
    await country.click();
    await page.getByRole("option", { name: "United States", exact: true }).click();
  }
  const state = page.getByRole("combobox", { name: /State\/Province/i });
  await state.click();
  await page.getByRole("option").and(page.locator(`[data-value="${billing.state}"]`)).click();
  await page.locator('input[name="cityTown"]:visible').fill(billing.city);
  await page.locator('input[name="postalCode"]:visible').fill(billing.postalCode);
  const address = page.locator('input[name="email"]:visible');
  if (await address.count()) await address.fill(email);
  const marketing = page.getByRole("checkbox", { name: /^I want to receive updates & promotional information from .+\.$/i });
  if (await marketing.count()) await marketing.uncheck();
  await page.getByRole("checkbox", { name: /I have read and agreed/ }).check();
}

async function deliveredPdf(page: Page, gate: Gate, orderId: string): Promise<Buffer> {
  await page.waitForURL(`${WEB}/tickets?order_id=${orderId}`);
  const canvas = page.getByTestId("ticket-canvas").filter({ visible: true });
  await canvas.waitFor({ state: "visible" });
  if (gate.receiptConflict) throw new HudsonCheckoutError("delivery_unconfirmed", true);
  if (!gate.verifiedTicketReference || await canvas.getAttribute("aria-label") !== `Boarding QR for Ticket Reference ${gate.verifiedTicketReference}`
    || await canvas.count() !== 1 || await page.getByTestId("barcode-failure-text").filter({ visible: true }).count()) {
    throw new HudsonCheckoutError("delivery_unconfirmed", true);
  }
  await page.emulateMedia({ media: "print" });
  const reference = page.getByText(`Ticket Reference ${gate.verifiedTicketReference}`, { exact: true }).filter({ visible: true });
  await reference.waitFor({ state: "visible" });
  const printed = page.locator('canvas:not([data-testid="ticket-canvas"]):visible');
  await printed.waitFor({ state: "visible" });
  if (await printed.count() !== 1 || await page.getByTestId("ticket-invalid-text").filter({ visible: true }).count()
    || await page.getByTestId("barcode-failure-text").filter({ visible: true }).count()) throw new HudsonCheckoutError("delivery_unconfirmed", true);
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): {
      width: number; height: number; getBoundingClientRect(): { width: number; height: number };
      getContext(kind: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null;
    }[] } }).document;
    const visible = Array.from(doc.querySelectorAll('canvas:not([data-testid="ticket-canvas"])')).filter(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const barcode = visible[0];
    if (visible.length !== 1 || !barcode || barcode.width < 20 || barcode.height < 20) return false;
    const pixels = barcode.getContext("2d")?.getImageData(0, 0, barcode.width, barcode.height).data;
    if (!pixels) return false;
    let dark = 0;
    let light = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]! < 100 || pixels[i]! > 200) light++;
      else if (pixels[i]! < 80) dark++;
    }
    return dark >= 25 && light >= 25;
  });
  const pdf = await page.pdf({ format: "Letter", printBackground: true });
  if (pdf.length < 800 || pdf.length > 8 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== "%PDF-") {
    throw new HudsonCheckoutError("delivery_unconfirmed", true);
  }
  return pdf;
}

export async function openHudsonCheckout(options: { email: string; browserWsEndpoint: string; signal?: AbortSignal }): Promise<HudsonCheckoutSession> {
  const { email, browserWsEndpoint, signal } = options;
  if (signal?.aborted) throw new HudsonCheckoutError("cancelled");
  if (!isHudsonBrowserEndpoint(browserWsEndpoint) || email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) {
    throw new HudsonCheckoutError("checkout_unavailable");
  }
  const browser = await chromium.connect(browserWsEndpoint, { timeout: TIMEOUT }).catch(() => {
    throw new HudsonCheckoutError("checkout_unavailable");
  });
  let browserContext: BrowserContext | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await browserContext?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await browserContext?.close().catch(() => {});
    await browser.close().catch(() => {});
  })();
  const abort = () => { void close(); };
  signal?.addEventListener("abort", abort, { once: true });
  const gate: Gate = { checkout: false, cardFields: false, tokenStarted: false, submitted: false,
    receiptVerified: false, receiptConflict: false, deniedPayment: false };
  try {
    if (signal?.aborted) throw new HudsonCheckoutError("cancelled");
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, locale: "en-US" });
    browserContext = context;
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    await context.routeWebSocket("**/*", socket => socket.close());
    const page = await context.newPage();
    await context.route("**/*", route => intercept(route, page, gate, email).catch(() => {}));
    await prepare(page, gate, email);
    let completed = false;
    return {
      totalCents: HUDSON_PRODUCT.totalCents,
      close: async () => { signal?.removeEventListener("abort", abort); await close(); },
      async complete(card, billing, traveler, beforeSubmit, completionSignal) {
        if (completed) throw new HudsonCheckoutError(gate.submitted ? "payment_unconfirmed" : "checkout_unavailable", gate.submitted);
        completed = true;
        completionSignal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted || completionSignal?.aborted) throw new HudsonCheckoutError("cancelled");
          if (billing.country !== "US" || !/^[A-Z]{2}$/.test(billing.state) || !/^\d{13,19}$/.test(card.number)
            || !/^\d{3,4}$/.test(card.cvv) || !/^(0[1-9]|1[0-2])$/.test(card.expMonth) || !/^(?:20)?\d{2}$/.test(card.expYear)
            || [traveler.firstName, traveler.lastName, billing.name, billing.street, billing.city, billing.postalCode]
              .some(value => !value.trim() || value.length > 140 || /\p{Cc}/u.test(value))) throw new HudsonCheckoutError("checkout_unavailable");
          await verification(page, gate);
          await total(page, "checkout");
          await exactCart(page);
          const pan = await secureField(page, "#card-number", "input#number");
          const cvv = await secureField(page, "#security-code", "input#securityCode");
          if (pan.frame === cvv.frame) throw new HudsonCheckoutError("checkout_unavailable");
          await page.locator('input[name="firstName"]:visible').fill(traveler.firstName);
          await page.locator('input[name="lastName"]:visible').fill(traveler.lastName);
          await page.locator('input[name="nameOnCard"]:visible').fill(billing.name);
          await page.locator('input[autocomplete="cc-exp-month"]:visible').fill(card.expMonth);
          await page.locator('input[autocomplete="cc-exp-year"]:visible').fill(card.expYear.slice(-2));
          if (!isVerifiedFieldFrame(page, pan.frame)) throw new HudsonCheckoutError("checkout_unavailable");
          await pan.field.fill(card.number);
          if (!isVerifiedFieldFrame(page, cvv.frame)) throw new HudsonCheckoutError("checkout_unavailable");
          await cvv.field.fill(card.cvv);
          gate.cardFields = true;
          await page.getByRole("button", { name: "Continue with card", exact: false }).click();
          await fillBilling(page, billing, email);
          await total(page, "checkout");
          await exactCart(page);
          await verification(page, gate);
          if (!gate.token) throw new HudsonCheckoutError("checkout_unavailable");
          const pay = page.getByRole("button", { name: /^Pay\s*\$2\.75$/i });
          await pay.waitFor({ state: "visible" });
          gate.purchase = { billing, traveler, cardholder: { expMonth: card.expMonth, expYear: card.expYear, last4: card.number.slice(-4) },
            beforeSubmit, signal: completionSignal ?? signal };
          await pay.click();
          await page.waitForURL(url => Boolean(gate.orderId && url.href === `${WEB}/tickets?order_id=${gate.orderId}`));
          if (!gate.orderId) throw new HudsonCheckoutError("payment_unconfirmed", gate.submitted);
          const bytes = await deliveredPdf(page, gate, gate.orderId);
          return { totalCents: HUDSON_PRODUCT.totalCents, filename: HUDSON_PRODUCT.filename, bytes, receiptVerified: gate.receiptVerified };
        } catch (error) {
          if (error instanceof HudsonCheckoutError) throw error;
          if (gate.submitted) throw new HudsonCheckoutError(gate.orderId ? "delivery_unconfirmed" : "payment_unconfirmed", true);
          if (signal?.aborted || completionSignal?.aborted) throw new HudsonCheckoutError("cancelled");
          await verification(page, gate).catch(error => { if (error instanceof HudsonCheckoutError) throw error; });
          throw new HudsonCheckoutError("checkout_unavailable");
        } finally {
          completionSignal?.removeEventListener("abort", abort);
          gate.purchase = undefined;
          gate.token = undefined;
          gate.cardFields = false;
        }
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    await close();
    if (error instanceof HudsonCheckoutError) throw error;
    throw new HudsonCheckoutError(signal?.aborted ? "cancelled" : "checkout_unavailable");
  }
}
