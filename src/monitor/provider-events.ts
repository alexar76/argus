import { randomUUID } from "node:crypto";
import { fetchNoRedirect } from "../credential-fetch.js";
import type { Logger } from "../types.js";
import { validateMonitorBaseUrl } from "./feed.js";
import type { MonitorFeedConfig } from "./types.js";

type ProviderOperation =
  | { provider: "laso"; operation: "card_quote" | "card_issue" | "card_checkout" }
  | { provider: "coinmarketcap"; operation: "quotes" }
  | { provider: "tavily"; operation: "search" };

export type ArgusProviderActivity = ProviderOperation & { status: "attempted" | "succeeded" | "failed" };
export type ReportProviderActivity = (activity: ArgusProviderActivity, eventId?: string) => void;

/** Emits only fixed labels. A slow Monitor cannot delay calls to providers. */
export function createProviderActivityReporter(cfg: MonitorFeedConfig, log: Logger): ReportProviderActivity {
  const base = validateMonitorBaseUrl(process.env.ALIEN_PROVIDER_EVENTS_URL?.trim() || cfg.url);
  const token = process.env.ALIEN_PROVIDER_EVENTS_TOKEN?.trim() || cfg.token.trim();
  let pending = 0;

  async function send(body: string): Promise<void> {
    try {
      const response = await fetchNoRedirect(`${base}/api/provider-events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) log.debug(`monitor provider event: HTTP ${response.status}`);
      await response.body?.cancel();
    } catch {
      log.debug("monitor provider event: delivery unavailable");
    } finally {
      pending--;
    }
  }

  return ({ provider, operation, status }, eventId = randomUUID()) => {
    if (!base || !token || pending >= 32) return;
    pending++;
    void send(JSON.stringify({ event_id: eventId, provider, source: "argus", operation, status }));
  };
}
