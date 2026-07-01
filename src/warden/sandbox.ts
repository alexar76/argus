import type { ToolDef, WardenPolicy } from "../types.js";

/**
 * Runtime policy layer for tool execution.
 *
 * NOTE: this is the JS-level policy layer, not a true sandbox. It classifies
 * tools, gates sensitive calls behind explicit approval, and watches egress for
 * a tool trying to phone home. OS-level process isolation
 * (seccomp / Landlock on Linux, sandbox-exec on macOS) is the v2 hardening that
 * confines the actual child process; until then these helpers are the boundary
 * the agent loop enforces in-process.
 */

/**
 * True if a tool name matches any sensitive pattern in the policy. Patterns use
 * `*` as a wildcard and match case-insensitively (e.g. "*delete*", "*transfer*").
 * Sensitive tools are still allowed to be advertised — they just require explicit
 * per-call approval before WARDEN lets them run.
 */
export function isSensitiveTool(toolName: string, policy: WardenPolicy): boolean {
  const name = toolName.toLowerCase();
  return policy.sensitiveToolPatterns.some((pat) => globMatch(pat, name));
}

/** Split a server's advertised tools into sensitive vs. safe by policy. */
export function classifyTools(
  tools: ToolDef[],
  policy: WardenPolicy,
): { sensitive: string[]; safe: string[] } {
  const sensitive: string[] = [];
  const safe: string[] = [];
  for (const tool of tools) {
    if (isSensitiveTool(tool.name, policy)) sensitive.push(tool.name);
    else safe.push(tool.name);
  }
  return { sensitive, safe };
}

/**
 * Outbound-request allowlist. Wrap any network egress a tool performs in
 * `check()` — a tool that tries to reach a host outside the allowlist is the
 * classic "phone home" exfiltration tell. Hostnames are matched case-insensitively
 * and a leading "*." entry matches subdomains (e.g. "*.example.com").
 */
export class EgressGuard {
  private readonly allow: string[];

  constructor(allowlist: string[]) {
    this.allow = allowlist.map((h) => h.trim().toLowerCase()).filter(Boolean);
  }

  check(url: string): { allowed: boolean; reason?: string } {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return { allowed: false, reason: `Unparseable URL: ${url}` };
    }
    if (this.allow.length === 0) {
      return { allowed: false, reason: `Egress blocked (empty allowlist): ${host}` };
    }
    for (const entry of this.allow) {
      if (entry === host) return { allowed: true };
      if (entry.startsWith("*.")) {
        const suffix = entry.slice(1); // ".example.com"
        if (host.endsWith(suffix) && host.length > suffix.length) return { allowed: true };
      }
    }
    return { allowed: false, reason: `Host not in egress allowlist: ${host}` };
  }
}

/** `*`-glob match (case-insensitive). Inputs are matched as whole strings. */
function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .toLowerCase()
    .split("*")
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`, "i").test(value);
}
