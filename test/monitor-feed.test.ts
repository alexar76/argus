import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../src/core/agent.js";
import { buildMonitorRunPayload } from "../src/monitor/build-run.js";
import {
  pushRunToMonitor,
  resolveArgusRunEndpoint,
  validateMonitorBaseUrl,
} from "../src/monitor/feed.js";
import { MonitorFeed } from "../src/monitor/heartbeat.js";
import { sanitizeMonitorText } from "../src/monitor/sanitize.js";
import { WardenBlockBuffer } from "../src/monitor/warden-snapshots.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("monitor-test", "error");

function stubRun(over: Partial<RunResult> = {}): RunResult {
  return {
    answer: "done",
    meter: { costUsd: 0.016, inputTokens: 100, outputTokens: 50, cachedTokens: 0, toolCalls: 2, steps: 3 },
    outcome: "success",
    provenance: [],
    audit: {
      approvals: { count: 0, intact: true, head: null },
      chain: [],
      mandate: {
        schema: "argus-mandate/v1",
        taskHash: "abc",
        budgetUsd: 0.5,
        toolsHash: "def",
        canonical: "task|0.5|def",
        commitment: "a".repeat(64),
        sealedAt: new Date().toISOString(),
      },
      spend: [],
      drift: [],
      session: {
        startedAt: "2026-06-28T12:00:00.000Z",
        endedAt: "2026-06-28T12:00:05.000Z",
        egressAttempts: 1,
        unauthorizedToolCalls: 0,
        ceilingExceeded: false,
        sensitiveApproved: [],
      },
    },
    ...over,
  };
}

describe("monitor feed", () => {
  let warden: WardenBlockBuffer;
  beforeEach(() => {
    warden = new WardenBlockBuffer();
  });

  it("validateMonitorBaseUrl rejects non-http schemes and embedded credentials", () => {
    expect(validateMonitorBaseUrl("https://magic-ai-factory.com/monitor")).toBe(
      "https://magic-ai-factory.com/monitor",
    );
    expect(validateMonitorBaseUrl("file:///etc/passwd")).toBeNull();
    expect(validateMonitorBaseUrl("javascript:alert(1)")).toBeNull();
    expect(validateMonitorBaseUrl("http://user:pass@127.0.0.1:9100")).toBeNull();
  });

  it("validateMonitorBaseUrl blocks remote http unless ARGUS_MONITOR_ALLOW_HTTP=1", () => {
    expect(validateMonitorBaseUrl("http://127.0.0.1:9100")).toBe("http://127.0.0.1:9100");
    expect(validateMonitorBaseUrl("http://evil.example.com/monitor")).toBeNull();
    process.env.ARGUS_MONITOR_ALLOW_HTTP = "1";
    expect(validateMonitorBaseUrl("http://evil.example.com/monitor")).toBe("http://evil.example.com/monitor");
    delete process.env.ARGUS_MONITOR_ALLOW_HTTP;
  });

  it("resolveArgusRunEndpoint appends /api/argus/run", () => {
    expect(resolveArgusRunEndpoint("http://127.0.0.1:9100")).toBe("http://127.0.0.1:9100/api/argus/run");
    expect(resolveArgusRunEndpoint("https://magic-ai-factory.com/monitor")).toBe(
      "https://magic-ai-factory.com/monitor/api/argus/run",
    );
  });

  it("sanitizeMonitorText redacts obvious secrets", () => {
    const s = sanitizeMonitorText("goal api_key=supersecretvalue12345 ok", 240);
    expect(s).toContain("[redacted]");
    expect(s).not.toContain("supersecret");
  });

  it("buildMonitorRunPayload maps oracle, hire, warden, receipt beats", () => {
    warden.record("fs-helper", {
      allow: false,
      score: 0.12,
      decidedBy: "static-scan",
      findings: [{ gate: "static-scan", severity: "high", code: "TOOL_DEF_INJECTION", message: "bad tool" }],
      allowedTools: [],
      blockedTools: ["exfiltrate_env"],
    });

    const result = stubRun({
      provenance: [
        {
          source: "oracle",
          tool: "oracle_random",
          capabilityId: "platon.random@v1",
          priceUsd: 0.004,
          verifiable: {
            type: "oracle-receipt",
            receipt: { commitment: "0x" + "9f".repeat(32) },
            signerPublicKey: "pk",
          },
        },
        {
          source: "hub",
          tool: "hub_invoke",
          capabilityId: "translate@v2",
          priceUsd: 0.012,
          trustScore: 0.81,
          receiptValid: true,
        },
      ],
      audit: {
        ...stubRun().audit,
        approvals: {
          count: 1,
          intact: true,
          head: { type: "commitment", preimage: "x", hash: "0x" + "4b".repeat(32), label: "head" },
        },
      },
    });

    const payload = buildMonitorRunPayload({
      task: "Draw a fair winner",
      result,
      wardenBlocks: warden.peek(),
      signerAddress: "0x1234567890123456789012345678901234567890",
    });

    expect(payload.goal).toBe("Draw a fair winner");
    expect(payload.beats.length).toBeGreaterThanOrEqual(4);
    expect(payload.beats[0].kind).toBe("warden");
    expect(payload.beats.some((b) => b.kind === "oracle")).toBe(true);
    expect(payload.beats.some((b) => b.kind === "hire")).toBe(true);
    expect(payload.beats.some((b) => b.kind === "receipt")).toBe(true);
    expect(payload.spendUsd).toBe(0.016);
    expect(payload.signer).toMatch(/^0x1234/);
    expect(payload.receiptHash).toContain("…");
  });

  it("pushRunToMonitor is fail-soft and sends Bearer auth", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await pushRunToMonitor(
      {
        id: "run_test",
        goal: "test",
        beats: [],
        spendUsd: 0,
        receiptHash: "",
        signer: "local",
      },
      { url: "http://127.0.0.1:9100", token: "secret-token" },
      log,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9100/api/argus/run");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    vi.unstubAllGlobals();
  });

  it("pushRunToMonitor skips when url or token missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await pushRunToMonitor(
      { id: "x", goal: "y", beats: [], spendUsd: 0, receiptHash: "", signer: "local" },
      { url: "", token: "" },
      log,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("MonitorFeed persists and re-pushes on heartbeat start", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tmp = await mkdtemp(join(tmpdir(), "argus-monitor-"));
    const feed = new MonitorFeed(
      { url: "http://127.0.0.1:9100", token: "secret-token" },
      log,
      tmp,
    );
    const payload = {
      id: "run_persist",
      goal: "persist me",
      beats: [{ kind: "receipt" as const, title: "t", detail: "d", meta: "m", status: "sealed" as const }],
      spendUsd: 0.01,
      receiptHash: "0xabc",
      signer: "local",
    };
    await feed.push(payload);
    fetchMock.mockClear();
    feed.startHeartbeat();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalled();
    feed.stop();
    vi.unstubAllGlobals();
  });
});
