import type { Logger } from "../types.js";
import type { MonitorFeedConfig, MonitorRunPayload } from "./types.js";
import { MONITOR_LIMITS } from "./sanitize.js";

const PUSH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 16_384;

/** Resolve POST target — supports bare :9100 and nginx `/monitor/` base paths. */
export function resolveArgusRunEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/api/argus/run`;
}

/**
 * Validate monitor push URL. Returns normalized base or null when unsafe/invalid.
 * Only http(s) allowed; rejects embedded credentials in the URL userinfo.
 * Remote http:// is blocked unless ARGUS_MONITOR_ALLOW_HTTP=1 (Bearer would be cleartext).
 */
export function validateMonitorBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === "http:" && !isLocalMonitorHost(parsed.hostname)) {
    if (process.env.ARGUS_MONITOR_ALLOW_HTTP !== "1") return null;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

function isLocalMonitorHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function payloadByteSize(body: MonitorRunPayload): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

/**
 * Push a verifiable run to Alien Monitor. Fail-soft: never throws to callers.
 * Requires both `url` and `token` in config; silently skips when either is missing.
 */
export async function pushRunToMonitor(
  payload: MonitorRunPayload,
  cfg: MonitorFeedConfig,
  log: Logger,
): Promise<void> {
  const base = validateMonitorBaseUrl(cfg.url);
  const token = cfg.token.trim();
  if (!base || !token) return;

  if (payloadByteSize(payload) > MAX_BODY_BYTES) {
    log.warn("monitor feed: payload too large, skipped");
    return;
  }

  const endpoint = resolveArgusRunEndpoint(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.debug(`monitor feed: POST ${endpoint} → ${res.status}`);
      return;
    }
    log.debug(`monitor feed: pushed run ${payload.id.slice(0, MONITOR_LIMITS.id)} (${payload.beats.length} beats)`);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("abort")) log.debug("monitor feed: timed out");
    else log.debug(`monitor feed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
