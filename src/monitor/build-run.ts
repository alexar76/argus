import { createHash } from "node:crypto";
import type { RunResult } from "../core/agent.js";
import type { ProvenanceEntry } from "../provenance/index.js";
import type { MonitorRunBeat, MonitorRunPayload } from "./types.js";
import type { WardenBlockSnapshot } from "./warden-snapshots.js";
import { MONITOR_LIMITS, finiteUsd, sanitizeMonitorText, shortHash } from "./sanitize.js";

export interface BuildMonitorRunInput {
  task: string;
  result: RunResult;
  wardenBlocks?: WardenBlockSnapshot[];
  /** Public wallet address only — never a private key. */
  signerAddress?: string;
  verifyUrl?: string;
}

function oracleBeat(entry: ProvenanceEntry): MonitorRunBeat {
  const cap = entry.capabilityId ?? entry.tool;
  const proof = entry.receiptValid !== false && entry.verifiable ? "proof ✓" : "local";
  const price =
    entry.priceUsd != null && Number.isFinite(entry.priceUsd)
      ? ` · $${entry.priceUsd.toFixed(4)}`
      : "";
  const receipt = entry.verifiable?.type === "oracle-receipt" ? entry.verifiable.receipt : null;
  const commit =
    receipt && typeof receipt.commitment === "string"
      ? shortHash(receipt.commitment)
      : receipt && typeof receipt.graph_commitment === "string"
        ? shortHash(receipt.graph_commitment as string)
        : "";
  return {
    kind: "oracle",
    title: "Called a verifiable oracle",
    detail: sanitizeMonitorText(`${cap} → signed oracle response`, MONITOR_LIMITS.beatDetail),
    meta: sanitizeMonitorText([commit, proof, price.replace(/^ · /, "")].filter(Boolean).join(" · "), MONITOR_LIMITS.beatMeta),
    status: "ok",
  };
}

function hireBeat(entry: ProvenanceEntry): MonitorRunBeat {
  const cap = entry.capabilityId ?? entry.tool;
  const trust =
    entry.trustScore != null && Number.isFinite(entry.trustScore)
      ? `LUMEN ${entry.trustScore.toFixed(2)}`
      : "";
  const price =
    entry.priceUsd != null && Number.isFinite(entry.priceUsd)
      ? `$${entry.priceUsd.toFixed(4)}`
      : "";
  const receipt = entry.receiptValid === false ? "receipt ✗" : "receipt ✓";
  return {
    kind: "hire",
    title: "Hired another agent",
    detail: sanitizeMonitorText(`discover → invoke ${cap} → settle`, MONITOR_LIMITS.beatDetail),
    meta: sanitizeMonitorText([cap, trust, price, receipt].filter(Boolean).join(" · "), MONITOR_LIMITS.beatMeta),
    status: entry.receiptValid === false ? "ok" : "paid",
  };
}

function wardenBeat(block: WardenBlockSnapshot): MonitorRunBeat {
  const tools =
    block.blockedTools.length > 0 ? ` · blocked: ${block.blockedTools.slice(0, 3).join(", ")}` : "";
  return {
    kind: "warden",
    title: "WARDEN refused a malicious tool",
    detail: sanitizeMonitorText(
      `"${block.serverName}" blocked before any tool ran${tools}`,
      MONITOR_LIMITS.beatDetail,
    ),
    meta: sanitizeMonitorText(
      `gate: ${block.decidedBy} · ${block.topFinding} · score ${block.score.toFixed(2)}`,
      MONITOR_LIMITS.beatMeta,
    ),
    status: "blocked",
  };
}

function driftBeat(tool: string, reasons: string[]): MonitorRunBeat {
  return {
    kind: "warden",
    title: "Sentinel flagged behavioral drift",
    detail: sanitizeMonitorText(`tool "${tool}": ${reasons.slice(0, 2).join("; ")}`, MONITOR_LIMITS.beatDetail),
    meta: sanitizeMonitorText("gate: sentinel · drift", MONITOR_LIMITS.beatMeta),
    status: "blocked",
  };
}

function receiptBeat(result: RunResult): MonitorRunBeat | null {
  const head = result.audit.approvals.head;
  const mandate = result.audit.mandate?.commitment;
  const hash = head?.type === "commitment" ? head.hash : mandate;
  if (!hash) return null;
  const intact = result.audit.approvals.intact;
  return {
    kind: "receipt",
    title: "Sealed a verifiable receipt",
    detail: sanitizeMonitorText(
      intact
        ? "Every step is signed. Verify the proofs — don't trust the agent."
        : "Consent chain integrity check failed — inspect before trusting.",
      MONITOR_LIMITS.beatDetail,
    ),
    meta: sanitizeMonitorText(`sha256 ${shortHash(hash)}`, MONITOR_LIMITS.beatMeta),
    status: intact ? "sealed" : "blocked",
  };
}

function runId(result: RunResult): string {
  const seed = `${result.audit.mandate?.commitment ?? ""}:${result.audit.session.startedAt}`;
  const h = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `run_${h}`;
}

/**
 * Build a monitor-safe payload from a completed ARGUS run.
 * Read-side only — no network, no secrets in output.
 */
export function buildMonitorRunPayload(input: BuildMonitorRunInput): MonitorRunPayload {
  const { task, result, wardenBlocks = [], signerAddress, verifyUrl } = input;
  const beats: MonitorRunBeat[] = [];

  for (const b of wardenBlocks) beats.push(wardenBeat(b));
  for (const entry of result.provenance) {
    beats.push(entry.source === "oracle" ? oracleBeat(entry) : hireBeat(entry));
  }
  for (const d of result.audit.drift) {
    if (d.reasons.length) beats.push(driftBeat(d.tool, d.reasons));
  }
  const receipt = receiptBeat(result);
  if (receipt) beats.push(receipt);

  const head = result.audit.approvals.head;
  const mandateHash = result.audit.mandate?.commitment;
  const receiptHash =
    head?.type === "commitment" ? head.hash : mandateHash ?? "";

  const payload: MonitorRunPayload = {
    id: sanitizeMonitorText(runId(result), MONITOR_LIMITS.id),
    goal: sanitizeMonitorText(task, MONITOR_LIMITS.goal),
    beats: beats.slice(0, MONITOR_LIMITS.maxBeats),
    spendUsd: finiteUsd(result.meter.costUsd),
    receiptHash: sanitizeMonitorText(receiptHash ? shortHash(receiptHash) : "", MONITOR_LIMITS.receiptHash),
    signer: sanitizeMonitorText(signerAddress ?? "local", MONITOR_LIMITS.signer),
  };

  if (verifyUrl && verifyUrl.startsWith("https://")) {
    payload.verifyUrl = sanitizeMonitorText(verifyUrl, MONITOR_LIMITS.verifyUrl);
  }

  return payload;
}
