import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLotteryTools } from "../src/economy/lottery.js";
import { createLogger } from "../src/logger.js";
import type { ChainContext } from "../src/ecosystem/networks.js";

const wallet = "0x000000000000000000000000000000000000dEaD" as const;
const participantId = `0x${"44".repeat(32)}` as `0x${string}`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARGUS_LOTTERY_HUB_URL;
  delete process.env.ARGUS_LOTTERY_RELAYER_URL;
  delete process.env.ARGUS_LOTTERY_AGENT_ID;
  delete process.env.ARGUS_LOTTERY_AGENT_TOKEN;
});

describe("federated lottery admission", () => {
  it("gets a wallet-bound proof from the home Hub before asking the relayer", async () => {
    process.env.ARGUS_LOTTERY_HUB_URL = "https://home.example/";
    process.env.ARGUS_LOTTERY_RELAYER_URL = "https://lottery.example/";
    process.env.ARGUS_LOTTERY_AGENT_ID = "agent-7";
    process.env.ARGUS_LOTTERY_AGENT_TOKEN = "secret-7";

    const entitlement = {
      purpose: "ai-agent-lottery-work-seat-v1",
      hub_url: "https://home.example",
      agent_id: "agent-7",
      participant_id: participantId,
      wallet: wallet.toLowerCase(),
      issued_at: 1_700_000_000,
      expires_at: 1_700_000_600,
      nonce: "proof",
      signature: { algorithm: "ed25519", value: "signed" },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ai-market/v2/lottery/work-seat-entitlement")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer secret-7" });
        expect(JSON.parse(String(init?.body))).toEqual({ agent_id: "agent-7", wallet });
        return new Response(JSON.stringify({ entitlement }), { status: 200 });
      }
      expect(url).toBe("https://lottery.example/work-seat");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ agent: wallet, round_id: 7, entitlement });
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      return new Response(JSON.stringify({
        round_id: 7,
        participant_id: participantId,
        weight_bps: 10_000,
        expiry: 1_700_000_600,
        signature: `0x${"33".repeat(65)}`,
        already_seated: false,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const simulateContract = vi.fn(async (request) => ({ request }));
    const writeContract = vi.fn(async () => `0x${"55".repeat(32)}` as `0x${string}`);
    const chain = {
      addresses: { lottery: "0x0000000000000000000000000000000000000001" },
      account: { address: wallet },
      publicClient: {
        readContract: vi.fn(async ({ functionName }) => {
          if (functionName === "currentRoundId") return 7n;
          if (functionName === "paused" || functionName === "workSeated") return false;
          throw new Error(`unexpected read ${functionName}`);
        }),
        simulateContract,
      },
      walletClient: { writeContract },
      explorerTx: (hash: string) => `https://scan.example/tx/${hash}`,
    } as unknown as ChainContext;

    const enter = buildLotteryTools(chain, createLogger("test", "error"))
      .find((tool) => tool.def.name === "lottery_enter")!;
    const result = await enter.run({}, {
      approved: true,
      log: createLogger("test", "error"),
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "enterFromWork",
      args: [7n, participantId, 10_000, 1_700_000_600n, `0x${"33".repeat(65)}`],
    }));
    expect(writeContract).toHaveBeenCalledOnce();
  });

  it("fails closed before contacting the relayer when Hub credentials are absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const chain = {
      addresses: { lottery: "0x0000000000000000000000000000000000000001" },
      account: { address: wallet },
      publicClient: {
        readContract: vi.fn(async ({ functionName }) => {
          if (functionName === "currentRoundId") return 7n;
          return false;
        }),
      },
      walletClient: {},
    } as unknown as ChainContext;
    const enter = buildLotteryTools(chain, createLogger("test", "error"))
      .find((tool) => tool.def.name === "lottery_enter")!;
    const result = await enter.run({}, {
      approved: true,
      log: createLogger("test", "error"),
    });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/ARGUS_LOTTERY_AGENT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
