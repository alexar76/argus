import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const product = "https://aiimperium.itch.io/co-working-startup-office-icon-pack";
const endpoint = (await readFile("/run/checkout/browser-ws", "utf8")).trim();
const browser = await chromium.connect(endpoint, { timeout: 5_000 }).catch(() => {
  throw new Error("Private Playwright connection failed");
});

try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const unguardedPage = await context.newPage();
    await assert.rejects(
      unguardedPage.goto("https://js.stripe.com/v3/", { timeout: 5_000 }),
      /ERR_PROXY_CONNECTION_FAILED/,
    );
    await unguardedPage.close();
    const allowed = new Set(["aiimperium.itch.io", "static.itch.io", "itch.io", "img.itch.io", "img.itch.zone", "js.stripe.com"]);
    const seen = new Set();
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.protocol !== "https:" || !allowed.has(url.hostname)) return route.abort();
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 7_000 });
      try {
        if (response.status() >= 300 && response.status() < 400) return route.abort();
        if (response.ok()) seen.add(url.hostname);
        await route.fulfill({ response });
      } finally {
        await response.dispose();
      }
    });
    await context.routeWebSocket("**/*", socket => socket.close());

    const page = await context.newPage();
    const response = await page.goto(`${product}/purchase`, { waitUntil: "load", timeout: 20_000 });
    assert.equal(response?.status(), 200);
    assert.equal(await page.locator('meta[property="og:title"]').getAttribute("content"),
      "Purchase Co-Working & Startup Office Icon Pack by aiimperium");
    assert.equal(await page.locator('input[name="price"]').inputValue(), "$2.99");
    assert.equal(await page.locator('input[name="email"]').count(), 1);
    assert.equal(await page.getByText("Co_Working_Startup_Office_Icon_Pack.zip", { exact: true }).count(), 1);
    assert.equal(await page.locator('button.checkout_stripe[data-source="stripe"]').count(), 1);
    assert(seen.has("static.itch.io"));

    const stripe = await context.request.get("https://js.stripe.com/v3/", {
      maxRedirects: 0, maxRetries: 0, timeout: 7_000,
    });
    assert.equal(stripe.status(), 200);
    await stripe.dispose();
    console.log("Public itch.io purchase and Stripe assets verified using GET only");
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
