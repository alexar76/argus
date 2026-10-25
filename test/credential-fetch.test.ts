import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { fetchNoRedirect } from "../src/credential-fetch.js";
import { A2AClient } from "../src/economy/a2a-client.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}

describe("credential-bearing transports", () => {
  it("never forwards API keys, mandate proofs or request bodies to a redirected origin", async () => {
    let received = 0;
    const sink = createServer((_req, res) => { received++; res.end('{}'); });
    let status = 307;
    const sinkUrl = await listen(sink);
    const origin = createServer((_req, res) => { res.writeHead(status, { location: sinkUrl }); res.end(); });
    const base = await listen(origin);
    try {
      for (const code of [301, 302, 303, 307, 308]) {
        status = code;
        await expect(fetchNoRedirect(base, { method: "POST", headers: { "X-API-Key": "disposable-credit-key",
          "X-AIMarket-Mandate-Proof": "disposable-proof" }, body: "private input", redirect: "follow" })).rejects.toThrow();
        await expect(new A2AClient({ hubUrl: base, apiKey: "disposable-credit-key" })
          .invoke("example@v1", { private: "input" })).rejects.toThrow();
        await expect(new AnthropicProvider({ apiKey: "disposable-provider-key", baseUrl: base })
          .chat({ model: "test", messages: [{ role: "user", content: "private input" }] })).rejects.toThrow();
      }
      expect(received).toBe(0);
    } finally { await close(origin); await close(sink); }
  });
});
