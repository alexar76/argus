import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { authorizeGmail } from "../src/cli/commands/mail-oauth.js";

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("node:http", () => ({ createServer }));

class LoopbackServer extends EventEmitter {
  bind?: string;
  close = vi.fn();
  closeAllConnections = vi.fn();

  listen(_port: number, host: string) {
    this.bind = host;
    queueMicrotask(() => this.emit("listening"));
  }
  address() { return { port: 43210 }; }
  request(url: string, host = "127.0.0.1:43210") {
    const res = { writeHead: vi.fn(), end: (_text: string, done: () => void) => done() };
    this.emit("request", { url, method: "GET", headers: { host } }, res);
    return res;
  }
}

beforeEach(() => createServer.mockReset());

it("uses loopback, verifies state and host, and exchanges the code with PKCE", async () => {
  const server = new LoopbackServer();
  createServer.mockReturnValue(server);
  const exchange = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({ refresh_token: "fixture-refresh" }));
  let auth!: URL;
  const refresh = await authorizeGmail({
    email: "owner@example.com", clientId: "fixture-client", clientSecret: "fixture-secret", signal: AbortSignal.timeout(2000), exchange,
    showUrl: (url) => {
      auth = new URL(url);
      const redirect = new URL(auth.searchParams.get("redirect_uri")!);
      const params = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "fixture-code" });
      expect(server.bind).toBe("127.0.0.1");
      expect(auth.origin).toBe("https://accounts.google.com");
      expect(server.request(`${redirect.pathname}?state=bad&code=wrong`).writeHead.mock.lastCall?.[0]).toBe(400);
      expect(server.request(`${redirect.pathname}?${params}`, "other.example").writeHead.mock.lastCall?.[0]).toBe(400);
      expect(server.request(`${redirect.pathname}?${params}`).writeHead.mock.lastCall?.[0]).toBe(200);
    },
  });
  expect(refresh).toBe("fixture-refresh");
  expect(exchange).toHaveBeenCalledTimes(1);
  const [tokenUrl, request] = exchange.mock.lastCall!;
  expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
  const body = request.body as URLSearchParams;
  expect(body.get("code")).toBe("fixture-code");
  expect(auth.searchParams.get("code_challenge")).toBe(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"));
  expect(server.close).toHaveBeenCalledOnce();
});

it("expires the callback without attempting token exchange", async () => {
  const server = new LoopbackServer();
  createServer.mockReturnValue(server);
  const ctrl = new AbortController();
  const exchange = vi.fn();
  await expect(authorizeGmail({
    email: "owner@example.com", clientId: "fixture-client", clientSecret: "fixture-secret", signal: ctrl.signal, exchange,
    showUrl: () => ctrl.abort(),
  })).rejects.toThrow("expired");
  expect(exchange).not.toHaveBeenCalled();
  expect(server.close).toHaveBeenCalledOnce();
});
