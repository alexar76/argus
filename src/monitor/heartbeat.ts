import type { Logger } from "../types.js";
import { pushRunToMonitor } from "./feed.js";
import { loadLastMonitorRun, saveLastMonitorRun } from "./persist.js";
import type { MonitorFeedConfig, MonitorRunPayload } from "./types.js";

/** Re-push before the monitor's 120s TTL expires. */
const REFRESH_MS = 90_000;

/**
 * Push + persist verifiable runs to Alien Monitor.
 * Re-pushes the last payload on an interval so UNI/LIVE panels stay live between tasks.
 */
export class MonitorFeed {
  private last: MonitorRunPayload | null;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly cfg: MonitorFeedConfig,
    private readonly log: Logger,
    private readonly stateDir: string,
  ) {
    this.last = loadLastMonitorRun(stateDir);
  }

  enabled(): boolean {
    return !!(this.cfg.url?.trim() && this.cfg.token?.trim());
  }

  async push(payload: MonitorRunPayload): Promise<void> {
    if (!this.enabled()) return;
    this.last = payload;
    saveLastMonitorRun(this.stateDir, payload);
    await pushRunToMonitor(payload, this.cfg, this.log);
  }

  /** On startup, re-push the last run; then refresh TTL every 90s. */
  startHeartbeat(): void {
    if (!this.enabled()) return;
    if (this.last) void pushRunToMonitor(this.last, this.cfg, this.log);
    this.timer = setInterval(() => {
      if (this.last) void pushRunToMonitor(this.last, this.cfg, this.log);
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
