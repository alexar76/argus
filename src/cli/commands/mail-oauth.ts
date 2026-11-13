import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { fetchNoRedirect } from "../../credential-fetch.js";
import { gmailOAuthClient, type GmailOAuthClient } from "../../mail/types.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALLBACK_PATH = "/mail/oauth2/callback";

export function readGoogleDesktopClient(file: string): GmailOAuthClient {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    const maxBytes = 16_384;
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > maxBytes) {
      throw new Error("Use a private Google Desktop app JSON file owned by the ARGUS user.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > maxBytes) throw new Error("Google Desktop app JSON is too large.");
    const parsed: unknown = JSON.parse(buffer.toString("utf8", 0, bytes));
    const installed = parsed && typeof parsed === "object" && "installed" in parsed ? parsed.installed : undefined;
    if (!installed || typeof installed !== "object" || !("client_id" in installed) || !("client_secret" in installed)) {
      throw new Error("Download the OAuth client JSON for a Google Desktop app.");
    }
    return gmailOAuthClient(installed.client_id, installed.client_secret);
  } finally {
    closeSync(fd);
  }
}

export async function authorizeGmail(options: {
  email: string;
  clientId: string;
  clientSecret: string;
  showUrl: (url: string) => void;
  signal: AbortSignal;
  port?: number;
  exchange?: typeof fetchNoRedirect;
}): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 });
  let onAbort: (() => void) | undefined;
  server.listen(options.port ?? 0, "127.0.0.1");
  try {
    await once(server, "listening", { signal: options.signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the Google authorization callback.");
    const redirect = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    options.signal.throwIfAborted();
    const callback = new Promise<string>((resolve, reject) => {
      onAbort = () => reject(new Error("Google authorization expired."));
      options.signal.addEventListener("abort", onAbort, { once: true });
      server.once("error", reject);
      server.on("request", (req, res) => {
        const incoming = req.url?.startsWith(`${CALLBACK_PATH}?`) ? new URL(req.url, redirect) : undefined;
        const receivedState = Buffer.from(incoming?.searchParams.get("state") ?? "", "utf8");
        const expectedState = Buffer.from(state, "utf8");
        const matches = receivedState.length === expectedState.length && timingSafeEqual(receivedState, expectedState);
        const valid = req.method === "GET" && req.headers.host === `127.0.0.1:${address.port}` && matches;
        const code = valid ? incoming?.searchParams.get("code") : undefined;
        const denied = valid && incoming?.searchParams.has("error");
        res.writeHead(code || denied ? 200 : 400, {
          "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close",
        });
        res.end(code || denied ? "Return to your ARGUS terminal to finish." : "Invalid authorization callback.", () => {
          if (code) resolve(code);
          if (denied) reject(new Error("Google authorization was declined."));
        });
      });
    });
    const auth = new URL(AUTHORIZATION_ENDPOINT);
    auth.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "https://mail.google.com/",
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      login_hint: options.email,
      state,
    }).toString();
    options.showUrl(auth.toString());
    const code = await callback;
    const response = await (options.exchange ?? fetchNoRedirect)(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: options.clientId, client_secret: options.clientSecret,
        code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code",
      }),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error("Google did not accept the authorization code.");
    const { refresh_token: refreshToken } = await response.json() as { refresh_token?: unknown };
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("Google did not issue an offline refresh token.");
    return refreshToken;
  } finally {
    if (onAbort) options.signal.removeEventListener("abort", onAbort);
    server.close();
    server.closeAllConnections();
  }
}
