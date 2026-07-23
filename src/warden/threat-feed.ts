import { verify, createPublicKey } from "node:crypto";
import type {
  Logger,
  McpServerRef,
  Severity,
  ThreatRecord,
  WardenFinding,
  WardenGate,
  WardenGateInput,
  WardenGateResult,
} from "../types.js";

/**
 * Threat-intel feed for known-bad MCP servers/tools.
 *
 * Reputation answers "is this server trusted?"; the threat feed answers "is this
 * server a *known* bad actor?". It ships with a small built-in deny-list of
 * patterns (credential-stealing, destructive commands, crypto-drainer keywords,
 * typosquat-style names) and can be topped up from a signed remote feed. The
 * remote feed MUST carry an Ed25519 signature verifiable with a pre-configured
 * public key — unsigned feeds are rejected to prevent threat-record injection.
 * The remote fetch degrades silently: a feed outage must never weaken the built-in
 * floor or crash a connection check.
 */

/** Built-in deny-list. Small but real — patterns seen in poisoned MCP servers. */
const BUILTIN: ThreatRecord[] = [
  {
    pattern: "*~/.ssh*",
    severity: "critical",
    code: "THREAT_SSH_KEY_READ",
    reason: "Server references the user's SSH key directory.",
    source: "builtin",
  },
  {
    pattern: "*id_rsa*",
    severity: "critical",
    code: "THREAT_SSH_KEY_READ",
    reason: "Server references a private SSH key file.",
    source: "builtin",
  },
  {
    pattern: "*rm -rf*",
    severity: "critical",
    code: "THREAT_DESTRUCTIVE_CMD",
    reason: "Server command performs a destructive recursive delete.",
    source: "builtin",
  },
  {
    pattern: "*:(){ :|:&};:*",
    severity: "critical",
    code: "THREAT_FORK_BOMB",
    reason: "Server command contains a shell fork bomb.",
    source: "builtin",
  },
  {
    pattern: "*drain*wallet*",
    severity: "critical",
    code: "THREAT_CRYPTO_DRAINER",
    reason: "Crypto-drainer keyword in server identity.",
    source: "builtin",
  },
  {
    pattern: "*seed*phrase*",
    severity: "high",
    code: "THREAT_SEED_PHRASE",
    reason: "Server references wallet seed phrases.",
    source: "builtin",
  },
  {
    pattern: "*sweep*funds*",
    severity: "critical",
    code: "THREAT_CRYPTO_DRAINER",
    reason: "Crypto-drainer keyword in server identity.",
    source: "builtin",
  },
  {
    pattern: "*.env*exfil*",
    severity: "critical",
    code: "THREAT_ENV_EXFIL",
    reason: "Server references exfiltrating environment files.",
    source: "builtin",
  },
  // Typosquat-style names mimicking the official reference servers.
  {
    pattern: "*offical-mcp*",
    severity: "high",
    code: "THREAT_TYPOSQUAT",
    reason: "Typosquat of an official MCP server name.",
    source: "builtin",
  },
  {
    pattern: "*modelcontextprotocoll*",
    severity: "high",
    code: "THREAT_TYPOSQUAT",
    reason: "Typosquat of modelcontextprotocol.",
    source: "builtin",
  },
  {
    pattern: "*filesytem*",
    severity: "medium",
    code: "THREAT_TYPOSQUAT",
    reason: "Typosquat of the filesystem reference server.",
    source: "builtin",
  },
];

export class ThreatFeed {
  private records: ThreatRecord[] = [...BUILTIN];
  private feedPublicKey?: string;
  private readonly log?: Logger;

  constructor(opts?: { feedPublicKey?: string; log?: Logger }) {
    this.feedPublicKey = opts?.feedPublicKey;
    this.log = opts?.log;
  }

  /** The built-in floor, always present regardless of remote load state. */
  get builtins(): ThreatRecord[] {
    return [...BUILTIN];
  }

  all(): ThreatRecord[] {
    return [...this.records];
  }

  /**
   * Fetch and verify a signed remote threat feed.
   *
   * Feed format: `{ records: ThreatRecord[], timestamp: number, signature: string }`
   * where `signature` is a hex-encoded Ed25519 signature over
   * `JSON.stringify({records, timestamp})` with stable key ordering.
   *
   * - Without a configured `feedPublicKey`, remote feeds are refused.
   * - Signature failure logs a warning and preserves the built-in floor.
   * - Network/parse errors degrade silently — built-ins remain.
   */
  async load(feedUrl?: string): Promise<void> {
    if (!feedUrl) return;
    if (!this.feedPublicKey) {
      this.log?.warn("threat feed URL configured but no feedPublicKey set — remote feed REFUSED (unsigned feeds not allowed)");
      return;
    }
    try {
      // AbortController with a 10 s timeout — a hanging feed must not block startup.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(feedUrl, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        this.log?.warn(`threat feed fetch returned ${res.status} — keeping built-in floor`);
        return;
      }
      // Reject oversized responses before parsing (OOM guard).
      const cl = res.headers.get("content-length");
      if (cl && Number(cl) > 512_000) {
        this.log?.warn(`threat feed: content-length ${cl} exceeds 512 KiB limit — rejected`);
        return;
      }
      const data: unknown = await res.json();
      if (!data || typeof data !== "object") return;
      const pkg = data as Record<string, unknown>;

      const records = pkg.records;
      const signature = pkg.signature;
      const timestamp = pkg.timestamp;
      if (!Array.isArray(records) || typeof signature !== "string" || (timestamp !== undefined && typeof timestamp !== "number")) {
        this.log?.warn("threat feed: missing or invalid fields (records, signature) — rejected");
        return;
      }

      // Verify Ed25519 signature over canonical JSON of {records, timestamp}.
      const payload = JSON.stringify({ records, timestamp });
      const sigBuf = Buffer.from(signature, "hex");
      const pubKey = createPublicKey({
        key: Buffer.from(this.feedPublicKey, "hex"),
        format: "der",
        type: "spki",
      });
      const ok = verify(null, Buffer.from(payload, "utf8"), pubKey, sigBuf);
      if (!ok) {
        this.log?.warn("threat feed: Ed25519 signature INVALID — feed rejected, built-in floor preserved");
        return;
      }

      const remote = records.filter(isThreatRecord);
      this.records = [...BUILTIN, ...remote];
      this.log?.info(`threat feed loaded: ${this.records.length} records (${BUILTIN.length} builtin + ${remote.length} remote, signature valid)`);
    } catch (err) {
      // Degrade gracefully: built-ins remain in effect.
      this.log?.debug(`threat feed load error: ${(err as Error).message}`);
    }
  }

  /** Match a server against every record; one finding per matched record. */
  match(server: McpServerRef): WardenFinding[] {
    const fields = [
      server.id,
      server.name,
      server.url ?? "",
      server.command ?? "",
      (server.args ?? []).join(" "),
    ];
    const hay = fields.join("\n").toLowerCase();

    const findings: WardenFinding[] = [];
    for (const rec of this.records) {
      if (patternMatches(rec.pattern, hay)) {
        findings.push({
          gate: "threat-feed",
          severity: rec.severity,
          code: rec.code,
          message: `${rec.reason} (matched "${rec.pattern}", source: ${rec.source})`,
        });
      }
    }
    return findings;
  }
}

/**
 * Gate wrapper around a ThreatFeed. Any match is disqualifying for the score; a
 * critical-severity match short-circuits the chain (fatal).
 */
export class ThreatGate implements WardenGate {
  readonly name = "threat-feed";

  constructor(private readonly feed: ThreatFeed) {}

  async evaluate(input: WardenGateInput): Promise<WardenGateResult> {
    const findings = this.feed.match(input.server);
    if (findings.length === 0) return { findings, score: 1 };
    const fatal = findings.some((f) => f.severity === "critical");
    return { findings, score: 0, fatal };
  }
}

/**
 * Case-insensitive match. `*` is a wildcard (glob); a pattern with no `*` is a
 * plain substring test. `hay` is expected to be pre-lowercased.
 */
function patternMatches(pattern: string, hay: string): boolean {
  const p = pattern.toLowerCase();
  if (!p.includes("*")) return hay.includes(p);
  const re = globToRegExp(p);
  return re.test(hay);
}

/**
 * Translate a `*`-glob into an anchored regex, escaping all other metachars.
 * The `s` (dotAll) flag is essential: the haystack joins server fields with
 * newlines, and without it `.*` would not cross a newline — silently defeating
 * every `*…*` pattern. (Regression-tested in test/warden.test.ts.)
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "is");
}

function isThreatRecord(v: unknown): v is ThreatRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const severities: Severity[] = ["info", "low", "medium", "high", "critical"];
  return (
    typeof r.pattern === "string" && r.pattern.length > 0 && r.pattern.length <= 2000 &&
    typeof r.code === "string" && r.code.length > 0 && r.code.length <= 200 &&
    typeof r.reason === "string" && r.reason.length > 0 && r.reason.length <= 2000 &&
    typeof r.source === "string" && r.source.length > 0 && r.source.length <= 200 &&
    typeof r.severity === "string" &&
    severities.includes(r.severity as Severity)
  );
}
