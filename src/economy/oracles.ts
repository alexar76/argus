import type { Logger, Tool } from "../types.js";

/** Max bytes for an oracle response. */
const MAX_ORACLE_BODY = 512_000;

/** Max bytes for an oracle error body. */
const MAX_ORACLE_ERROR_BODY = 2048;

/** Base URL for the default oracle portal. */
const PORTAL_DEFAULT = "https://oracles.modelmarket.dev";

/** Enforce HTTPS for oracle URLs (localhost exempt for dev). */
function requireSecureOracle(url: string, label: string): void {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(url)) {
    throw new Error(`${label} must be HTTPS (or localhost for dev): got "${url}"`);
  }
}

/** Validate Content-Type before JSON parsing. */
function checkJsonContent(res: Response, label: string): void {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("+json")) {
    throw new Error(`${label}: expected JSON but got "${ct}"`);
  }
}

/** Read bounded error body. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_ORACLE_ERROR_BODY);
  } catch {
    return "(body unreadable)";
  }
}

/** Allow-list of AICOM oracle-family capabilities ARGUS may call natively.
 *  These are the REAL capability IDs the deployed oracle-family manifest exposes
 *  (kept in sync with each oracle's capabilities.py — verified against the family). */
export const ORACLE_CAPABILITIES = new Set([
  // Platon — verifiable randomness / dynamical oracle (federated into the family)
  "platon.random@v1",
  "platon.beacon@v1",
  "platon.commit@v1",
  "platon.oracle@v1",
  "platon.ask@v1",
  // LUMEN — reputation / trust (also what WARDEN scores MCP servers with)
  "lumen.reputation@v1",
  // Chronos — verifiable delay function (VDF)
  "chronos.eval@v1",
  "chronos.verify@v1",
  // Lattice — low-discrepancy (quasi-random) sequences
  "lattice.sequence@v1",
  // Murmuration — robust consensus aggregation
  "murmuration.aggregate@v1",
  // Colony — combinatorial optimization with a quality certificate
  "colony.optimize@v1",
  // Turing — blue-noise structured sampling
  "turing.bluenoise@v1",
  // Percola — network-resilience / percolation threshold
  "percola.threshold@v1",
  "percola.verify@v1",
  // Fermat — provably-optimal routing/composition (dual certificate)
  "fermat.route@v1",
  "fermat.verify@v1",
  // Ablation — systemic cascade-risk (self-organized criticality)
  "ablation.cascade@v1",
  "ablation.verify@v1",
  // Landauer — thermodynamic compute-cost audit
  "landauer.audit@v1",
  "landauer.verify@v1",
  // Sortes — trustless verifiable randomness (ECVRF, RFC 9381)
  "sortes.draw@v1",
  "sortes.verify@v1",
  // Gauss — Gaussian-process uncertainty field + active sampling (Expected Improvement)
  "gauss.field@v1",
  "gauss.suggest@v1",
  "gauss.verify@v1",
  // Aestus — verifiable timed-release / time-lock puzzle (RSW)
  "aestus.seal@v1",
  "aestus.open@v1",
  "aestus.verify@v1",
  // Betti — topological data analysis (persistent homology)
  "betti.homology@v1",
  "betti.distance@v1",
  // Kantor — optimal transport / Wasserstein (+ Kantorovich dual certificate)
  "kantor.transport@v1",
  "kantor.verify@v1",
  // Fourier — spectral / graph-Laplacian (Fiedler value, spectral cut)
  "fourier.spectrum@v1",
  "fourier.verify@v1",
]);

const PHYSICS_SLUGS = new Set(["ablation", "fermat", "landauer", "percola"]);

/**
 * Resolve the invoke base URL for a capability. Mirrors alien-monitor's oracle
 * nginx layout: Platon at portal root, Chronos/physics at /{slug}, family at /family.
 *
 * Security: all resolved URLs are validated as HTTPS (or localhost dev). Env-var
 * overrides (ARGUS_ORACLE_{SLUG}_URL) are validated before use — an attacker who
 * can set env vars could otherwise redirect oracle calls to a malicious endpoint.
 */
export function resolveOracleInvokeBase(capabilityId: string, oracleFamilyUrl: string): string {
  const slug = capabilityId.split(".")[0] ?? "";
  const portal = (process.env.ARGUS_ORACLE_PORTAL ?? PORTAL_DEFAULT).replace(/\/$/, "");
  const family = (process.env.ARGUS_ORACLE_FAMILY_URL ?? oracleFamilyUrl).replace(/\/$/, "");
  requireSecureOracle(portal, "ARGUS_ORACLE_PORTAL");
  requireSecureOracle(family, "ARGUS_ORACLE_FAMILY_URL");
  // Per-capability env-var overrides — validate each before use.
  const envKey = `ARGUS_ORACLE_${slug.toUpperCase()}_URL`;
  const override = process.env[envKey]?.trim();
  if (override) {
    requireSecureOracle(override, envKey);
    return override.replace(/\/$/, "");
  }
  if (slug === "platon") {
    const platonUrl = (process.env.ARGUS_ORACLE_PLATON_URL ?? portal).replace(/\/$/, "");
    requireSecureOracle(platonUrl, "ARGUS_ORACLE_PLATON_URL");
    return platonUrl;
  }
  if (slug === "chronos") {
    const chronosUrl = (process.env.ARGUS_ORACLE_CHRONOS_URL ?? `${portal}/chronos`).replace(/\/$/, "");
    requireSecureOracle(chronosUrl, "ARGUS_ORACLE_CHRONOS_URL");
    return chronosUrl;
  }
  if (PHYSICS_SLUGS.has(slug)) return `${portal}/${slug}`;
  return family.endsWith("/family") ? family : `${portal}/family`;
}

/** Thin client for the oracle-family AI-Market v2 invoke endpoint (off-chain HTTPS). */
export class OracleClient {
  private readonly familyUrl: string;
  /** Cached oracle-family signer public key (undefined=unfetched, null=unavailable). */
  private signerKey: string | null | undefined;
  constructor(oracleFamilyUrl: string, private readonly log: Logger, private readonly timeoutMs = 8000) {
    this.familyUrl = oracleFamilyUrl.replace(/\/$/, "");
  }

  async invoke(
    capabilityId: string,
    input: unknown,
    productId?: string,
  ): Promise<{ output: unknown; priceUsd?: number; receipt?: unknown; signerPublicKey?: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const base = resolveOracleInvokeBase(capabilityId, this.familyUrl);
    // The hub's invoke endpoint requires product_id; default it from the
    // capability prefix (e.g. "platon.random@v1" → "prod-platon"), overridable.
    const product_id = productId ?? `prod-${capabilityId.split(".")[0]}`;
    try {
      const res = await fetch(`${base}/ai-market/v2/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability_id: capabilityId, product_id, input }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`oracle HTTP ${res.status}: ${await readErrorBody(res)}`);
      // Size guard before parsing JSON (OOM defence).
      const cl = res.headers.get("content-length");
      if (cl && Number(cl) > MAX_ORACLE_BODY) {
        throw new Error(`oracle response: content-length ${cl} exceeds ${MAX_ORACLE_BODY} byte limit`);
      }
      checkJsonContent(res, "oracle");
      const json: any = await res.json();
      // Surface the signer's public key so the signed receipt is independently
      // re-verifiable (Provenance → `argus verify`). Best-effort + cached: if it
      // can't be fetched (offline), the result is still returned, just unverifiable.
      const signerPublicKey = await this.fetchSignerKey(base);
      return { output: json.output ?? json, priceUsd: json.price_usd, receipt: json.receipt, signerPublicKey };
    } finally {
      clearTimeout(t);
    }
  }

  /** Fetch (once, cached) the oracle-family Ed25519 signer public key from .well-known. */
  private async fetchSignerKey(base: string): Promise<string | undefined> {
    if (this.signerKey !== undefined) return this.signerKey ?? undefined;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${base}/.well-known/ai-market.json`, { signal: ctrl.signal });
      const j: any = res.ok ? await res.json() : {};
      this.signerKey = typeof j.signer_public_key === "string" ? j.signer_public_key : null;
    } catch (err) {
      this.log.debug(`oracle signer key unavailable: ${(err as Error).message}`);
      this.signerKey = null;
    } finally {
      clearTimeout(t);
    }
    return this.signerKey ?? undefined;
  }
}

/**
 * Native, TRUSTED oracle tools (first-party → bypass WARDEN). Read-only and
 * wallet-free: most oracle reads are free or paid out of band, so they need no
 * approval. These let ARGUS use AICOM's verifiable math (randomness, reputation,
 * VDF, consensus…) natively instead of "go fetch a URL".
 */
export function buildOracleTools(client: OracleClient): Tool[] {
  const oracleInvoke: Tool = {
    def: {
      name: "oracle_call",
      description:
        "Call an AICOM oracle capability (verifiable math). Allowed capability_id values: " +
        [...ORACLE_CAPABILITIES].join(", ") +
        ". Returns the signed oracle output.",
      inputSchema: {
        type: "object",
        properties: {
          capability_id: { type: "string", description: "e.g. platon.random@v1, lumen.reputation@v1" },
          input: { type: "object", description: "capability-specific input object" },
          product_id: { type: "string", description: "optional; defaults to prod-<prefix>" },
        },
        required: ["capability_id"],
      },
    },
    source: { kind: "builtin" },
    run: async (args) => {
      const cap = String(args.capability_id ?? "");
      if (!ORACLE_CAPABILITIES.has(cap)) {
        return { ok: false, content: `capability "${cap}" not in the allow-list. Allowed: ${[...ORACLE_CAPABILITIES].join(", ")}` };
      }
      try {
        const r = await client.invoke(cap, (args.input as unknown) ?? {}, args.product_id ? String(args.product_id) : undefined);
        return { ok: true, content: JSON.stringify(r.output), data: r };
      } catch (err) {
        return { ok: false, content: `oracle ${cap} failed: ${(err as Error).message}` };
      }
    },
  };

  const oracleRandom: Tool = {
    def: {
      name: "oracle_random",
      description: "Get verifiable randomness from the Platon oracle (platon.random@v1). Use for unbiased choices.",
      inputSchema: {
        type: "object",
        properties: { bytes: { type: "integer", description: "number of random bytes, 1-64 (default 8)" } },
      },
    },
    source: { kind: "builtin" },
    run: async (args) => {
      const n = Math.max(1, Math.min(64, Number(args.bytes ?? 8) || 8));
      try {
        const r = await client.invoke("platon.random@v1", { num_bytes: n }, "prod-platon");
        return { ok: true, content: JSON.stringify(r.output), data: r };
      } catch (err) {
        return { ok: false, content: `oracle_random failed: ${(err as Error).message}` };
      }
    },
  };

  return [oracleInvoke, oracleRandom];
}
