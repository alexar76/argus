// ARGUS drives the checkout browsers (itch.io, Hudson Link) with chromium.connect() to a Playwright server built from
// deploy/checkout-browser. That server answers a client of another major.minor version with "428 Precondition
// Required — Playwright version mismatch", so a purchase cannot even open its browser. npm 0.4.0 shipped
// playwright-core 1.65.0 (a Dependabot import) next to a 1.64.1 browser kit; this test keeps the two together.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the Playwright client ARGUS ships matches the checkout browser kit", () => {
  const pkg = JSON.parse(read("package.json"));
  const dockerfile = read("deploy/checkout-browser/Dockerfile");
  const compose = read("deploy/checkout-browser/compose.yaml");
  const prepare = read("deploy/checkout-browser/prepare.sh");

  const client = String(pkg.dependencies["playwright-core"]);
  const base = /FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/.exec(dockerfile)?.[1];
  const server = /COPY playwright-core-(\d+\.\d+\.\d+)\.tgz/.exec(dockerfile)?.[1];
  const image = /image: argus-checkout-browser:playwright-(\d+\.\d+\.\d+)/.exec(compose)?.[1];
  const fetched = /playwright-core-(\d+\.\d+\.\d+)\.tgz/.exec(prepare)?.[1];

  it("is pinned to one exact version", () => {
    expect(client).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the version the browser server, its base image and its tag use", () => {
    expect([base, server, image, fetched]).toEqual([client, client, client, client]);
  });

  it("is the version installed", () => {
    const installed = createRequire(import.meta.url)("playwright-core/package.json").version;
    expect(installed).toBe(client);
  });
});
