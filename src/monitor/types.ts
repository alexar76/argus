/** Beat kinds accepted by Alien Monitor `argus_feed._clean_beat`. */
export type MonitorBeatKind = "oracle" | "warden" | "hire" | "receipt";

export type MonitorBeatStatus = "ok" | "blocked" | "paid" | "sealed";

export interface MonitorRunBeat {
  kind: MonitorBeatKind;
  title: string;
  detail: string;
  meta: string;
  status: MonitorBeatStatus;
}

/** Payload for `POST /api/argus/run` — mirrors frontend `ArgusRunData`. */
export interface MonitorRunPayload {
  id: string;
  goal: string;
  beats: MonitorRunBeat[];
  spendUsd: number;
  receiptHash: string;
  signer: string;
  verifyUrl?: string;
  /** Roster identity — Alien Monitor ARGUS · N fleet. */
  instance_id?: string;
  display_name?: string;
  wallet?: string;
  version?: string;
  mode?: string;
  economy?: "on" | "off" | string;
  host?: string;
}

/** Lightweight presence for `POST /api/argus/heartbeat`. */
export interface MonitorHeartbeatPayload {
  instance_id: string;
  display_name?: string;
  wallet?: string;
  version?: string;
  mode?: string;
  economy?: "on" | "off" | string;
  host?: string;
}

export interface MonitorFeedConfig {
  /** Alien Monitor base URL (no trailing slash). Empty = push disabled. */
  url: string;
  /** Bearer token (`ALIEN_API_TOKEN`). Empty = push disabled. */
  token: string;
}
