import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MonitorRunPayload } from "./types.js";

const FILE = "monitor-last-run.json";

/** Reload the last pushed run so restarts + heartbeat can refresh monitor TTL. */
export function loadLastMonitorRun(stateDir: string): MonitorRunPayload | null {
  try {
    const raw = readFileSync(join(stateDir, FILE), "utf8");
    const data = JSON.parse(raw) as MonitorRunPayload;
    if (!data || typeof data !== "object" || !Array.isArray(data.beats)) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveLastMonitorRun(stateDir: string, payload: MonitorRunPayload): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, FILE), JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
}
