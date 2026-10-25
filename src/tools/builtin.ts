import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { isNonPublicAddress } from "./public-address.js";
import type { Logger, MemoryStore, Tool } from "../types.js";
import type { EgressGuard } from "@aimarket/warden";

export interface BuiltinDeps {
  memory: MemoryStore;
  log: Logger;
  /** Optional outbound allowlist for web_fetch. When present, egress is gated. */
  egress?: EgressGuard;
}

export const WEB_FETCH_MAX_BYTES = 2_000_000;

/**
 * Trusted, built-in tools. Unlike MCP tools (hostile-by-default, vetted by
 * WARDEN), these ship with ARGUS and need no firewall — but they're deliberately
 * conservative: read-only network fetch and memory recall. Anything that mutates
 * the host belongs behind an MCP server so WARDEN governs it.
 */
export function buildBuiltinTools(deps: BuiltinDeps): Tool[] {
  return [webFetch(deps), recallMemory(deps)];
}

function webFetch({ log, egress }: BuiltinDeps): Tool {
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
        // TOCTOU defense: DNS is checked TWICE per hop. Once BEFORE connecting via
        // assertPublicUrl (fast fail + cheap), and once AT connect time via
        // guardedFetch, whose socket-level `lookup` (see guardedLookup) fires when
        // the TCP connection is actually opened and rejects any private address the
        // host now resolves to. That second check is the real anti-rebinding guard:
        // a DNS answer that flips to a private IP after the pre-check still hits it.
        let res: GuardedResponse | null = null;
        for (let hop = 0; hop < 4; hop++) {
          // Egress allowlist (anti-exfiltration): when the operator configured
          // one, a fetch to a host outside it is blocked — re-checked on every
          // redirect hop so a redirect can't bounce off the allowlist.
          if (egress) {
            const verdict = egress.check(url);
            if (!verdict.allowed) {
              return { ok: false, content: `egress blocked by allowlist: ${verdict.reason ?? url}` };
            }
          }
          await assertPublicUrl(url);
          res = await guardedFetch(url, { signal: ctrl.signal });
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            if (hop === 3) return { ok: false, content: "too many redirects" };
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
  for (const ip of ips) if (isNonPublicAddress(ip)) throw new Error(`blocked private/internal address (${host} → ${ip})`);
}

/** Minimal Response-shaped view over a node:http(s) reply — only what web_fetch reads. */
interface GuardedResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * A dns.lookup-compatible resolver that Node invokes at ACTUAL TCP-connect time
 * (the socket layer calls it when the connection is opened, not before). It
 * re-resolves the host and rejects any private/loopback/link-local/metadata
 * address via the same {@link isNonPublicAddress} logic as the pre-fetch check — closing
 * the DNS-rebinding TOCTOU window that a pre-check alone leaves open, because a
 * DNS answer that flips to a private IP after the pre-check is still caught here.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const allOpts: LookupAllOptions = { ...options, all: true };
  dnsLookupCb(hostname, allOpts, (err, addresses) => {
    if (err) return callback(err, "", 0);
    for (const a of addresses) {
      if (isNonPublicAddress(a.address)) {
        const blocked: NodeJS.ErrnoException = new Error(`blocked private/internal address at connect (${hostname} → ${a.address})`);
        blocked.code = "ESSRFBLOCKED";
        return callback(blocked, "", 0);
      }
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) {
      const nf: NodeJS.ErrnoException = new Error(`cannot resolve ${hostname}`);
      nf.code = "ENOTFOUND";
      return callback(nf, "", 0);
    }
    return callback(null, first.address, first.family);
  });
}

/**
 * Single-hop GET with a connect-time SSRF guard. Uses node:http/https instead of
 * global fetch so we can install {@link guardedLookup} as the socket-level DNS
 * resolver — global fetch exposes no connect-time lookup hook without an undici
 * dispatcher, which ARGUS does not depend on. Does NOT follow redirects: the
 * caller re-checks (assertPublicUrl + egress) on every hop.
 */
function guardedFetch(rawUrl: string, opts: { signal: AbortSignal }): Promise<GuardedResponse> {
  const u = new URL(rawUrl);
  const options: RequestOptions = {
    method: "GET",
    signal: opts.signal,
    headers: { "user-agent": "argus/0.1" },
    lookup: guardedLookup,
  };
  return new Promise<GuardedResponse>((resolve, reject) => {
    const handler = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("web_fetch response aborted")));
      const tooLarge = () => {
        const error = new Error(`web_fetch response exceeds ${WEB_FETCH_MAX_BYTES} bytes`);
        reject(error);
        res.destroy(error);
      };
      if (Number(res.headers['content-length']) > WEB_FETCH_MAX_BYTES) {
        tooLarge();
        return;
      }
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > WEB_FETCH_MAX_BYTES) { tooLarge(); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: {
            get: (name: string) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
            },
          },
          text: async () => body,
        });
      });
    };
    const req = u.protocol === "https:" ? httpsRequest(u, options, handler) : httpRequest(u, options, handler);
    req.on("error", reject);
    req.end();
  });
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
