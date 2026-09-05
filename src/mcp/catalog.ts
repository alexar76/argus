import type { Logger, McpServerRef } from "../types.js";

/**
 * MCP catalog connector. Pulls server descriptors from public MCP registries so
 * ARGUS can discover servers to (carefully) connect to. Everything discovered
 * here is treated as hostile-by-default and MUST pass WARDEN before use.
 *
 * Supports a generic JSON shape: an array of {id?,name,transport?,command?,args?,
 * url?} or an object with a `servers`/`results` array. Unknown shapes are skipped
 * with a debug log rather than throwing — discovery never breaks the agent.
 */
export class CatalogConnector {
  constructor(private readonly log: Logger, private readonly timeoutMs = 8000) {}

  async fetchCatalog(url: string): Promise<McpServerRef[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json) ? json : json.servers ?? json.results ?? json.data ?? [];
      const refs = rows.map((r, i) => this.normalize(r, url, i)).filter((r): r is McpServerRef => r !== null);
      this.log.debug(`catalog ${url}: ${refs.length} servers`);
      return refs;
    } catch (err) {
      this.log.warn(`catalog ${url} unavailable: ${(err as Error).message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchAll(urls: string[]): Promise<McpServerRef[]> {
    const lists = await Promise.all(urls.map((u) => this.fetchCatalog(u)));
    return lists.flat();
  }

  private normalize(r: any, catalog: string, i: number): McpServerRef | null {
    if (!r || typeof r !== "object") return null;
    const name = r.name ?? r.title ?? r.id;
    if (!name) return null;
    // SECURITY: only URL-based (http/sse) servers may be auto-discovered from a
    // remote catalog. A catalog must never make ARGUS spawn a local process, so
    // stdio servers and any catalog-supplied command/args/env are rejected —
    // those must be operator-configured locally in argus.config.json.
    if (!r.url || typeof r.url !== "string") {
      this.log.debug(`catalog "${catalog}" entry "${name}" skipped (no url; stdio must be local)`);
      return null;
    }
    const id = String(r.id ?? r.slug ?? name).replace(/\s+/g, "-").toLowerCase() + `@${i}`;
    const transport: McpServerRef["transport"] = r.transport === "sse" ? "sse" : "http";
    return { id, name: String(name), transport, url: r.url, catalog };
  }
}
