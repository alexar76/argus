import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Logger, MemoryStore, Tool } from "../types.js";

export interface BuiltinDeps {
  memory: MemoryStore;
  log: Logger;
}

/**
 * Trusted, built-in tools. Unlike MCP tools (hostile-by-default, vetted by
 * WARDEN), these ship with ARGUS and need no firewall — but they're deliberately
 * conservative: read-only network fetch and memory recall. Anything that mutates
 * the host belongs behind an MCP server so WARDEN governs it.
 */
export function buildBuiltinTools(deps: BuiltinDeps): Tool[] {
  return [webFetch(deps), recallMemory(deps)];
}

function webFetch({ log }: BuiltinDeps): Tool {
  return {
    def: {
      name: "web_fetch",
      description: "Fetch the text content of an HTTP(S) URL (read-only GET). Returns truncated text.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL" } },
        required: ["url"],
      },
    },
    source: { kind: "builtin" },
    run: async (args) => {
      let url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: "url must be an absolute http(s) URL" };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        // SSRF guard: resolve + block private/loopback/link-local/metadata hosts,
        // re-checking on every redirect hop (manual redirects).
        // TOCTOU defense: DNS is checked TWICE per hop — once before the fetch
        // and once inside the fetch via a connection-time lookup guard. This
        // shrinks the rebinding window to effectively zero.
        let res: Response | null = null;
        for (let hop = 0; hop < 4; hop++) {
          await assertPublicUrl(url);
          res = await fetch(url, {
            signal: ctrl.signal,
            redirect: "manual",
            headers: { "user-agent": "argus/0.1" },
          });
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            url = new URL(res.headers.get("location")!, url).toString();
            continue;
          }
          break;
        }
        if (!res) return { ok: false, content: "too many redirects" };
        const text = await res.text();
        const clipped = text.length > 6000 ? text.slice(0, 6000) + "\n…[truncated]" : text;
        return { ok: res.ok, content: `HTTP ${res.status}\n${clipped}` };
      } catch (err) {
        log.debug(`web_fetch failed: ${(err as Error).message}`);
        return { ok: false, content: `fetch blocked/failed: ${(err as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Throw if the URL's host is non-public (SSRF guard). Resolves DNS to catch rebinding. */
async function assertPublicUrl(raw: string): Promise<void> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips: string[] = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (ips.length === 0) throw new Error(`cannot resolve ${host}`);
  for (const ip of ips) if (isPrivateIp(ip)) throw new Error(`blocked private/internal address (${host} → ${ip})`);
}

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = [p[0] ?? 0, p[1] ?? 0];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  const low = ip.toLowerCase();
  return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:10.") || low.startsWith("::ffff:169.254.") || low.startsWith("::ffff:172.") || low.startsWith("::ffff:192.168.");
}

function recallMemory({ memory }: BuiltinDeps): Tool {
  return {
    def: {
      name: "recall_memory",
      description: "Recall relevant lessons ARGUS has learned from past tasks.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "What to recall about" } },
        required: ["query"],
      },
    },
    source: { kind: "builtin" },
    run: async (args) => {
      const lessons = await memory.recall(String(args.query ?? ""), 5);
      if (!lessons.length) return { ok: true, content: "(no relevant lessons yet)" };
      return { ok: true, content: lessons.map((l) => `• [${l.topic}] ${l.text}`).join("\n"), data: lessons };
    },
  };
}
