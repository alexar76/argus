import type { Logger } from "../types.js";
import { pushHeartbeatToMonitor, pushRunToMonitor } from "./feed.js";
import { loadOrCreateInstanceId } from "./instanceId.js";
import { loadLastMonitorRun, saveLastMonitorRun } from "./persist.js";
import type { MonitorFeedConfig, MonitorHeartbeatPayload, MonitorRunPayload } from "./types.js";

/** Re-push run before the monitor's 120s TTL expires. */
const RUN_REFRESH_MS = 90_000;
/** Presence ping — keeps instance in ARGUS · N active window (300s). */
const HEARTBEAT_MS = 90_000;

export interface MonitorIdentity {
  instanceId: string;
  displayName?: string;
  wallet?: string;
  version?: string;
  mode?: string;
  economy?: "on" | "off" | string;
  host?: string;
}

/**
 * Push + persist verifiable runs to Alien Monitor.
 * Heartbeats keep this install on the fleet roster (one ball, searchable list).
 */
export class MonitorFeed {
  private last: MonitorRunPayload | null;
  private runTimer?: ReturnType<typeof setInterval>;
  private beatTimer?: ReturnType<typeof setInterval>;
  private identity: MonitorIdentity;

  constructor(
    private readonly cfg: MonitorFeedConfig,
    private readonly log: Logger,
    private readonly stateDir: string,
    identity?: Partial<MonitorIdentity>,
  ) {
    this.last = loadLastMonitorRun(stateDir);
    const instanceId = identity?.instanceId || loadOrCreateInstanceId(stateDir, identity?.wallet);
    this.identity = {
      instanceId,
      displayName: identity?.displayName,
      wallet: identity?.wallet,
      version: identity?.version,
      mode: identity?.mode,
      economy: identity?.economy ?? "off",
      host: identity?.host,
    };
  }

  enabled(): boolean {
    return !!(this.cfg.url?.trim() && this.cfg.token?.trim());
  }

  getInstanceId(): string {
    return this.identity.instanceId;
  }

  setIdentity(patch: Partial<MonitorIdentity>): void {
    this.identity = { ...this.identity, ...patch, instanceId: patch.instanceId || this.identity.instanceId };
  }

  private enrich(payload: MonitorRunPayload): MonitorRunPayload {
    return {
      ...payload,
      instance_id: payload.instance_id || this.identity.instanceId,
      display_name: payload.display_name || this.identity.displayName,
      wallet: payload.wallet || this.identity.wallet || payload.signer,
      version: payload.version || this.identity.version,
      mode: payload.mode || this.identity.mode,
      economy: payload.economy || this.identity.economy,
      host: payload.host || this.identity.host,
    };
  }

  private heartbeatBody(): MonitorHeartbeatPayload {
    return {
      instance_id: this.identity.instanceId,
      display_name: this.identity.displayName,
      wallet: this.identity.wallet,
      version: this.identity.version,
      mode: this.identity.mode,
      economy: this.identity.economy,
      host: this.identity.host,
    };
  }

  async push(payload: MonitorRunPayload): Promise<void> {
    if (!this.enabled()) return;
    const enriched = this.enrich(payload);
    this.last = enriched;
    saveLastMonitorRun(this.stateDir, enriched);
    await pushRunToMonitor(enriched, this.cfg, this.log);
  }

  async ping(): Promise<void> {
    if (!this.enabled()) return;
    await pushHeartbeatToMonitor(this.heartbeatBody(), this.cfg, this.log);
  }

  /** On startup: heartbeat + optional last run; then refresh on intervals. */
  startHeartbeat(): void {
    if (!this.enabled()) return;
    void this.ping();
    if (this.last) void pushRunToMonitor(this.enrich(this.last), this.cfg, this.log);
    this.beatTimer = setInterval(() => {
      void this.ping();
    }, HEARTBEAT_MS);
    this.beatTimer.unref?.();
    this.runTimer = setInterval(() => {
      if (this.last) void pushRunToMonitor(this.enrich(this.last), this.cfg, this.log);
    }, RUN_REFRESH_MS);
    this.runTimer.unref?.();
  }

  stop(): void {
    if (this.runTimer) clearInterval(this.runTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.runTimer = undefined;
    this.beatTimer = undefined;
  }
}
