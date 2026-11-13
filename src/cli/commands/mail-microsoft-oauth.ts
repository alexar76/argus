import { setTimeout as delay } from "node:timers/promises";
import { fetchNoRedirect } from "../../credential-fetch.js";
import {
  MICROSOFT_DEVICE_CODE_ENDPOINT, MICROSOFT_TOKEN_ENDPOINT, microsoftMailScopes, microsoftOAuthClientId,
} from "../../mail/types.js";

function microsoftLoginUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Microsoft did not provide a sign-in page.");
  const url = new URL(value);
  const path = url.pathname.toLowerCase();
  const shortLink = (url.origin === "https://microsoft.com" || url.origin === "https://www.microsoft.com")
    && (path === "/devicelogin" || path === "/link");
  const signInPage = url.origin === "https://login.microsoftonline.com"
    && (path === "/common/oauth2/deviceauth" || path === "/consumers/oauth2/deviceauth");
  if ((!shortLink && !signInPage) || url.username || url.password || url.search || url.hash) {
    throw new Error("Microsoft returned an unexpected sign-in page.");
  }
  return url.href;
}

export async function authorizeMicrosoftMail(options: {
  clientId: string;
  incomingOnly?: boolean;
  showCode: (url: string, userCode: string) => void;
  signal: AbortSignal;
  request?: typeof fetchNoRedirect;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<string> {
  const clientId = microsoftOAuthClientId(options.clientId);
  const request = options.request ?? fetchNoRedirect;
  const wait = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const post = (endpoint: string, body: Record<string, string>, signal: AbortSignal) => request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  options.signal.throwIfAborted();
  const start = await post(MICROSOFT_DEVICE_CODE_ENDPOINT, { client_id: clientId, scope: microsoftMailScopes(options.incomingOnly) }, options.signal);
  if (!start.ok) throw new Error("Microsoft declined the device sign-in request.");
  const device = await start.json() as Record<string, unknown>;
  const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn, interval } = device;
  if (typeof deviceCode !== "string" || !deviceCode || deviceCode.length > 8192
      || typeof userCode !== "string" || !/^[A-Za-z0-9-]{4,24}$/.test(userCode)
      || typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < 1) {
    throw new Error("Microsoft returned an invalid device sign-in response.");
  }
  const url = microsoftLoginUrl(device.verification_uri);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(expiresIn, 900) * 1000)]);
  let seconds = typeof interval === "number" && Number.isInteger(interval) && interval > 0 ? Math.min(interval, 900) : 5;
  options.showCode(url, userCode);
  while (!signal.aborted) {
    await wait(seconds * 1000, signal);
    signal.throwIfAborted();
    const response = await post(MICROSOFT_TOKEN_ENDPOINT, {
      client_id: clientId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }, signal);
    const body = await response.json() as Record<string, unknown>;
    if (response.ok) {
      const refresh = body.refresh_token;
      if (typeof refresh !== "string" || !refresh || refresh.length > 4096 || /\s/u.test(refresh)) {
        throw new Error("Microsoft did not issue an offline refresh token.");
      }
      return refresh;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      seconds += 5;
      continue;
    }
    throw new Error("Microsoft declined the device sign-in or it expired.");
  }
  throw new Error("Microsoft device sign-in expired.");
}
