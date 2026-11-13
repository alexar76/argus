import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const endpoint = new URL((await readFile("/run/checkout/browser-ws", "utf8")).trim());
const host = process.env.CHECKOUT_SMOKE_HOST ?? endpoint.hostname;
endpoint.hostname = host;
assert.equal((await fetch(`http://${host}:47871/json`, { redirect: "error" })).status, 404);
await assert.rejects(chromium.connect(`ws://${host}:47871/invalid`, { timeout: 2_000 }));

const browser = await chromium.connect(endpoint.href, { timeout: 5_000 }).catch(() => {
  throw new Error("Private Playwright connection failed");
});
try {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("chrome://sandbox/");
    const status = await page.locator("body").innerText();
    assert.match(status, /PID namespaces\s+Yes/i);
    assert.match(status, /Network namespaces\s+Yes/i);
    assert.match(status, /Seccomp-BPF sandbox\s+Yes/i);

    await context.route("https://example.invalid/fixture", route => route.fulfill({
      contentType: "text/html",
      body: "<title>Checkout smoke</title><p>Offline browser fixture</p>",
    }));
    await page.goto("https://example.invalid/fixture");
    assert.equal(await page.title(), "Checkout smoke");
    await assert.rejects(page.goto("https://example.invalid/unrouted", { timeout: 2_000 }));
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
console.log("Private Playwright connection and Chromium namespaces/seccomp passed");
