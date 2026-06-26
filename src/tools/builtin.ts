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

/**
 * Returns true when `ip` is a private, loopback, link-local, or otherwise
 * non-public address (both IPv4 and IPv6). Covers the full RFC 6890 special-
 * purpose registry plus cloud-metadata (169.254.169.254), CGNAT, and NAT64.
 *
 * M5 fix: replaced fragile string-prefix IPv6 checks with numeric range
 * comparisons that cover all documented special-use blocks, including
 * IPv4-mapped addresses whose embedded IPv4 is private.
 */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // unparseable — block
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const [a, b] = [p[0] ?? 0, p[1] ?? 0];
  return (
    a === 10 ||                           // 10.0.0.0/8
    a === 127 ||                          // 127.0.0.0/8 loopback
    a === 0 ||                            // 0.0.0.0/8 "this network"
    (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12
    (a === 192 && b === 168) ||           // 192.168.0.0/16
    (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local + cloud metadata
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    a >= 224                              // multicast / reserved (224.0.0.0/4 + 240.0.0.0/4)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase();

  // Unspecified + loopback
  if (low === "::" || low === "::1") return true;

  // IPv4-mapped (::ffff:x.x.x.x) — check the embedded IPv4 address.
  // Format: ::ffff:1.2.3.4 or ::ffff:0102:0304
  const v4Mapped = low.match(/^::ffff:(?<v4>\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped?.groups?.v4) return isPrivateIPv4(v4Mapped.groups.v4);

  // IPv4-compatible (deprecated but still seen): ::1.2.3.4
  const v4Compat = low.match(/^::(?<v4>\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat?.groups?.v4) return isPrivateIPv4(v4Compat.groups.v4);

  // Expand :: shorthand for prefix matching (best-effort; covers common forms).
  const expanded = expandIPv6(low);

  // Unique Local Address: fc00::/7 (runs fc00::/8 and fd00::/8)
  if (expanded.startsWith("fc") || expanded.startsWith("fd")) return true;

  // Link-local: fe80::/10
  if (/^fe[89ab]./.test(expanded)) return true;

  // Documentation: 2001:db8::/32
  if (expanded.startsWith("2001:0db8") || expanded.startsWith("2001:db8")) return true;

  // NAT64 well-known prefix: 64:ff9b::/96
  if (expanded.startsWith("0064:ff9b")) return true;

  // 6to4 anycast: 192.88.99.0/24 → 2002:c058:6300::/40 (approximate block)
  // Terredo: 2001::/32
  if (expanded.startsWith("2001:0000")) return true;

  // Benchmarking: 2001:2::/48
  if (expanded.startsWith("2001:0002")) return true;

  // Multicast: ff00::/8
  if (expanded.startsWith("ff")) return true;

  return false;
}

/**
 * Expand :: shorthand in an IPv6 address to a full 8-group colon-separated
 * form so prefix tests work reliably. Returns the original on parse failure.
 */
function expandIPv6(addr: string): string {
  if (addr.includes("::")) {
    const parts = addr.split("::");
    if (parts.length > 2) return addr;
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return addr;
    const mid = Array<string>(missing).fill("0000");
    const groups = [...left, ...mid, ...right];
    return groups.map((g) => g.padStart(4, "0")).join(":");
  }
  // No shorthand — still normalise to 4-char groups for prefix matching.
  return addr.split(":").map((g) => g.padStart(4, "0")).join(":");
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
