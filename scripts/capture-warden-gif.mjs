#!/usr/bin/env node
/**
 * Record WARDEN blocking a poisoned MCP server → docs/screenshots/warden-blocks-poisoned-mcp.gif
 * Uses playwright + gifenc from aicom-landing devDeps (sibling package).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "docs", "screenshots", "warden-blocks-poisoned-mcp.gif");
const HTML = join(ROOT, "docs", "screenshots", "warden-blocks-poisoned-mcp.html");
const LANDING_OUT = join(ROOT, "..", "ecosystem-landing", "argus", "assets", "warden-blocks-poisoned-mcp.gif");

const require = createRequire(join(ROOT, "..", "aicom-landing", "package.json"));
const { chromium } = require("playwright");
const sharp = require("sharp");
const gifenc = require("gifenc");
const { GIFEncoder, quantize, applyPalette } = gifenc;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForTimeout(800);

  const frames = [];
  const snap = async () => {
    const png = await page.screenshot({ type: "png" });
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    frames.push({ data: new Uint8ClampedArray(data), width: info.width, height: info.height });
  };

  for (let i = 0; i < 36; i++) {
    await page.waitForTimeout(120);
    await snap();
  }

  await browser.close();

  const gif = GIFEncoder();
  const delay = 120;
  for (const f of frames) {
    const palette = quantize(f.data, 256);
    const index = applyPalette(f.data, palette);
    gif.writeFrame(index, f.width, f.height, { palette, delay });
  }
  gif.finish();
  const bytes = Buffer.from(gif.bytes());
  writeFileSync(OUT, bytes);
  writeFileSync(LANDING_OUT, bytes);
  console.log(`Wrote ${OUT} (${(bytes.length / 1024).toFixed(0)} KB)`);
  console.log(`Wrote ${LANDING_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
