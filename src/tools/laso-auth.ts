import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { readProviderJson } from "../economy/external-payment.js";

export const LASO_ORIGIN = "https://laso.finance";
const AUTH_URL = `${LASO_ORIGIN}/auth`;
const BASE_CHAIN = "eip155:8453";
const MAX_CHALLENGE_MS = 300_000;
const CLOCK_SKEW_MS = 30_000;
const AUTH_RESPONSE_LIMIT = 65_536;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function authenticate(account: ReturnType<typeof privateKeyToAccount>, request: typeof fetch) {
  const init = () => ({ method: "GET", redirect: "error" as const, signal: AbortSignal.timeout(12_000) });
  const challenge = await request(AUTH_URL, { ...init(), headers: { accept: "application/json" } });
  const header = challenge.headers.get("payment-required");
  await challenge.body?.cancel();
  if (challenge.status !== 402 || !header || header.length > AUTH_RESPONSE_LIMIT || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) {
    throw new Error("Laso returned no supported wallet authentication challenge");
  }
  const required = object(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  const extension = object(object(required.extensions)["sign-in-with-x"]);
  const { domain, uri, statement, version, nonce, issuedAt, expirationTime, resources } = object(extension.info);
  if (required.x402Version !== 2 || object(required.resource).url !== AUTH_URL
      || domain !== "laso.finance" || uri !== AUTH_URL || statement !== "Sign in to Laso Finance" || version !== "1"
      || typeof nonce !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(nonce)
      || typeof issuedAt !== "string" || typeof expirationTime !== "string"
      || !Array.isArray(resources) || resources.length !== 1 || resources[0] !== AUTH_URL
      || !Array.isArray(extension.supportedChains) || !extension.supportedChains.some((raw) => {
        const chain = object(raw);
        return chain.chainId === BASE_CHAIN && chain.type === "eip191";
      })) {
    throw new Error("Laso wallet authentication challenge does not match the expected route and chain");
  }
  const issued = new Date(issuedAt);
  const expires = new Date(expirationTime);
  const now = Date.now();
  if (!Number.isFinite(issued.getTime()) || !Number.isFinite(expires.getTime())
      || issued.getTime() > now + CLOCK_SKEW_MS || issued.getTime() <= now - MAX_CHALLENGE_MS
      || expires.getTime() <= Math.max(now, issued.getTime())
      || expires.getTime() - issued.getTime() > MAX_CHALLENGE_MS + CLOCK_SKEW_MS) {
    throw new Error("Laso wallet authentication challenge expired or has invalid timestamps");
  }
  const claims = { domain, address: account.address, uri, statement, version, nonce, issuedAt, expirationTime,
    resources: [AUTH_URL], chainId: BASE_CHAIN, type: "eip191" } as const;
  const message = createSiweMessage({ ...claims, resources: [...claims.resources], chainId: 8453,
    issuedAt: issued, expirationTime: expires });
  const signature = await account.signMessage({ message });
  const response = await request(AUTH_URL, { ...init(), headers: { accept: "application/json",
    "SIGN-IN-WITH-X": Buffer.from(JSON.stringify({ ...claims, signature })).toString("base64") } });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Laso wallet authentication returned HTTP ${response.status}`);
  }
  const payload = object(await readProviderJson(response, AUTH_RESPONSE_LIMIT));
  const auth = object(payload.auth);
  const token = auth.id_token;
  const ttl = typeof auth.expires_in === "number" || (typeof auth.expires_in === "string" && /^\d{1,5}$/.test(auth.expires_in))
    ? Number(auth.expires_in) : 0;
  if (typeof payload.user_id !== "string" || payload.user_id.toLowerCase() !== account.address.toLowerCase()
      || typeof token !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/.test(token)
      || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 3600) {
    throw new Error("Laso wallet authentication did not return a valid session for this wallet");
  }
  return { token, expires: Date.now() + ttl * 1000 - Math.min(60_000, ttl * 500) };
}

/** Session tokens live in memory and are refreshed by a free, domain-bound wallet signature. */
export function lasoWalletAuth(walletKey: () => Hex | null, request: typeof fetch = fetch) {
  let session: { address: string; token: string; expires: number } | undefined;
  let pending: { address: string; result: Promise<string> } | undefined;
  return async () => {
    const key = walletKey();
    if (!key) {
      session = undefined;
      throw new Error("Laso authentication needs an unlocked external Base wallet");
    }
    const account = privateKeyToAccount(key);
    const { address } = account;
    if (session?.address === address && session.expires > Date.now()) return session.token;
    if (pending?.address === address) return pending.result;
    const result = authenticate(account, request).then((auth) => {
      if (walletKey() !== key) throw new Error("Laso wallet changed during authentication");
      session = { address, ...auth };
      return auth.token;
    }).finally(() => {
      if (pending?.result === result) pending = undefined;
    });
    pending = { address, result };
    return result;
  };
}
