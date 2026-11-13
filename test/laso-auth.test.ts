import type { Hex } from "viem";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { buildLasoCardTools } from "../src/tools/laso.js";
import { lasoWalletAuth } from "../src/tools/laso-auth.js";

const ORIGIN = "https://laso.finance";
const AUTH = `${ORIGIN}/auth`;
const TIME = Date.parse("2026-11-13T09:31:00Z");
const log = createLogger("laso-auth-test", "error");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

function gateway(options: { info?: Record<string, unknown>; resource?: string; chain?: string; address?: string;
  merchantStatus?: string; ttl?: string; rejects?: boolean } = {}) {
  const signed: Record<string, unknown>[] = [];
  let session = 0;
  const request = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(url.origin).toBe(ORIGIN);
    expect(init?.redirect).toBe("error");
    expect(headers.has("payment-signature")).toBe(false);
    expect(headers.has("x-payment")).toBe(false);
    if (url.pathname === "/search-merchants") {
      expect(url.searchParams.get("q")).toBe("Example Store");
      expect(headers.get("authorization")).toBe(`Bearer wallet-token-${session}`);
      return Response.json({ merchants: [{ name: "Example Store", status: options.merchantStatus ?? "accepted" },
        { name: "Different Store", status: "accepted" }] });
    }
    expect(url.href).toBe(AUTH);
    expect(init?.method).toBe("GET");
    expect(headers.has("authorization")).toBe(false);
    const credential = headers.get("sign-in-with-x");
    if (!credential) {
      const info = { domain: "laso.finance", uri: AUTH, version: "1", nonce: `testnonce${session}`, resources: [AUTH],
        issuedAt: new Date(Date.now()).toISOString(), expirationTime: new Date(Date.now() + 300_000).toISOString(),
        statement: "Sign in to Laso Finance", ...options.info };
      return new Response(null, { status: 402, headers: { "payment-required": encode({ x402Version: 2,
        resource: { url: options.resource ?? AUTH }, extensions: { "sign-in-with-x": { info,
          supportedChains: [{ chainId: options.chain ?? "eip155:8453", type: "eip191" }] } } }) } });
    }
    const claims = JSON.parse(Buffer.from(credential, "base64").toString("utf8"));
    signed.push(claims);
    expect(claims).toMatchObject({ domain: "laso.finance", uri: AUTH, statement: "Sign in to Laso Finance",
      resources: [AUTH], chainId: "eip155:8453", type: "eip191" });
    const message = createSiweMessage({ ...claims, chainId: 8453, issuedAt: new Date(claims.issuedAt),
      expirationTime: new Date(claims.expirationTime) });
    expect(await verifyMessage({ address: claims.address, message, signature: claims.signature })).toBe(true);
    if (options.rejects) return new Response(null, { status: 402 });
    session += 1;
    return Response.json({ user_id: options.address ?? claims.address.toLowerCase(), auth: {
      id_token: `wallet-token-${session}`, expires_in: options.ttl ?? "3600", refresh_token: "unused-refresh-token",
    } });
  });
  return { request, signed };
}

afterEach(() => vi.useRealTimers());

it("reuses the session for the same wallet and refreshes with a fresh free signature", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TIME);
  const key = generatePrivateKey();
  const { request, signed } = gateway();
  const auth = lasoWalletAuth(() => key, request);
  await expect(Promise.all([auth(), auth()])).resolves.toEqual(["wallet-token-1", "wallet-token-1"]);
  await expect(auth()).resolves.toBe("wallet-token-1");
  expect(request).toHaveBeenCalledTimes(2);
  expect(signed[0]?.address).toBe(privateKeyToAccount(key).address);
  vi.setSystemTime(TIME + 3_541_000);
  await expect(auth()).resolves.toBe("wallet-token-2");
  expect(request).toHaveBeenCalledTimes(4);
  expect(signed.map((item) => item.nonce)).toEqual(["testnonce0", "testnonce1"]);
});

it.each([
  { info: { domain: "example.com" } },
  { info: { uri: `${ORIGIN}/get-card` } },
  { info: { statement: "Authorize payment" } },
  { info: { nonce: "bad" } },
  { info: { resources: [AUTH, `${ORIGIN}/get-card`] } },
  { info: { issuedAt: new Date(TIME - 301_000).toISOString() } },
  { info: { expirationTime: new Date(TIME - 1).toISOString() } },
  { info: { expirationTime: new Date(TIME + 600_000).toISOString() } },
  { info: { issuedAt: new Date(TIME + 20_000).toISOString(), expirationTime: new Date(TIME + 10_000).toISOString() } },
  { resource: `${ORIGIN}/other` },
  { chain: "eip155:1" },
])("refuses an invalid sign-in challenge before sending a signature (%j)", async (options) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TIME);
  const { request, signed } = gateway(options);
  const key = generatePrivateKey();
  await expect(lasoWalletAuth(() => key, request)()).rejects.toThrow(/challenge/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(signed).toEqual([]);
});

it.each([{ address: "0x" + "12".repeat(20) }, { ttl: "86400" }, { rejects: true }])(
  "refuses an invalid session without retrying a signed nonce (%j)", async (options) => {
    const { request, signed } = gateway(options);
    const key = generatePrivateKey();
    await expect(lasoWalletAuth(() => key, request)()).rejects.toThrow(/authentication/);
    expect(request).toHaveBeenCalledTimes(2);
    expect(signed).toHaveLength(1);
  },
);

it("does not reuse a session for another or locked wallet", async () => {
  let key: Hex | null = generatePrivateKey();
  const { request, signed } = gateway();
  const auth = lasoWalletAuth(() => key, request);
  await expect(auth()).resolves.toBe("wallet-token-1");
  key = generatePrivateKey();
  await expect(auth()).resolves.toBe("wallet-token-2");
  expect(signed[1]?.address).toBe(privateKeyToAccount(key).address);
  key = null;
  await expect(auth()).rejects.toThrow(/unlocked/);
  expect(request).toHaveBeenCalledTimes(4);
});

it("uses free wallet auth for the configured merchant and refuses another merchant's acceptance", async () => {
  const key = generatePrivateKey();
  const pay = vi.fn();
  const { request } = gateway({ merchantStatus: "not_accepted" });
  const [quote] = buildLasoCardTools({ pay, merchant: "Example Store", maxCents: 500, walletKey: () => key, fetch: request });
  expect((await quote!.run({ checkoutCents: 499 }, { log })).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
  const result = await quote!.run({ checkoutCents: 500 }, { log });
  expect(result).toMatchObject({ ok: false, content: expect.stringContaining("no confirmed acceptance") });
  expect(result.content).not.toMatch(/wallet-token|unused-refresh-token/);
  expect(request).toHaveBeenCalledTimes(3);
  expect(pay).not.toHaveBeenCalled();
});

it("honors an explicitly supplied owner token and prepares an exact quote without signing or paying", async () => {
  const walletKey = vi.fn(() => generatePrivateKey());
  const pay = vi.fn();
  const request = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/search-merchants");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-token");
    return Response.json({ merchants: [{ name: "Example Store", status: "accepted" }] });
  });
  const [quote] = buildLasoCardTools({ pay, merchant: "Example Store", maxCents: 500, token: () => "owner-token",
    walletKey, fetch: request });
  expect(await quote!.run({ checkoutCents: 500 }, { log })).toMatchObject({ ok: true,
    content: expect.stringContaining("Example Store | US prepaid | 5.00 USDC loaded | no reload") });
  expect(request).toHaveBeenCalledTimes(1);
  expect(walletKey).not.toHaveBeenCalled();
  expect(pay).not.toHaveBeenCalled();
});
