import type { EconomyProvider, Logger, SellableCapability } from "../types.js";

export interface MeshProviderOptions {
  meshUrl: string;
  /** Path of the agent-registry endpoint on the mesh service. */
  agentsPath?: string;
  name: string;
  /** EVM address (0x…) bound as the agent's wallet identity. */
  evmAddress?: string;
  /** Public endpoint for the agent; HTTPS required by the mesh except localhost. */
  endpointUrl?: string;
  log: Logger;
  timeoutMs?: number;
}

/**
 * Supply-side client: registers ARGUS as an agent identity in the AI Service
 * Mesh and lists capabilities it will sell. Registered + wallet-bound agents are
 * treated as self-custodial participants (eligible for the agent lottery /
 * machine-UBI). Best-effort and non-fatal: a mesh outage never affects the
 * agent's local operation.
 */
export class MeshProvider implements EconomyProvider {
  private readonly base: string;
  private readonly agentsPath: string;
  private agentId: string | null = null;
  private readonly pending: SellableCapability[] = [];

  constructor(private readonly o: MeshProviderOptions) {
    this.base = o.meshUrl.replace(/\/$/, "");
    // HTTPS is required except for localhost (dev/testing).
    if (!/^https:\/\//i.test(this.base) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(this.base)) {
      throw new Error(`mesh URL must be HTTPS (or localhost for dev): got "${o.meshUrl}"`);
    }
    this.agentsPath = o.agentsPath ?? "/ai-service-mesh/api/agents";
  }

  async register(): Promise<{ agentId: string; trustScore: number; status: string }> {
    const body: Record<string, unknown> = {
      name: this.o.name,
      endpoint_url: this.o.endpointUrl ?? "http://localhost",
      capabilities: this.pending.map((c) => c.id),
    };
    if (this.o.evmAddress) body.evm_address = this.o.evmAddress;

    const json = await this.post(this.agentsPath, body);
    this.agentId = String(json.id ?? json.agent_id ?? "");
    const result = {
      agentId: this.agentId,
      trustScore: Number(json.trust_score ?? 0.5),
      status: String(json.status ?? "PENDING"),
    };
    this.o.log.info(`registered in mesh as ${result.agentId} (trust ${result.trustScore}, ${result.status})`);
    return result;
  }

  async listCapability(cap: SellableCapability): Promise<{ capabilityId: string }> {
    this.pending.push(cap);
    // If already registered, best-effort attach; otherwise it ships at register().
    if (this.agentId) {
      try {
        await this.post(`${this.agentsPath}/${this.agentId}/capabilities`, {
          capability_id: cap.id,
          name: cap.name,
          description: cap.description,
          input_schema: cap.inputSchema,
          output_schema: cap.outputSchema,
          price_per_call_usd: cap.priceUsd,
        });
      } catch (err) {
        this.o.log.warn(`capability "${cap.id}" staged locally (mesh attach failed: ${(err as Error).message})`);
      }
    }
    return { capabilityId: cap.id };
  }

  private async post(path: string, body: unknown): Promise<Record<string, any>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 10_000);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`mesh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as Record<string, any>;
    } finally {
      clearTimeout(timer);
    }
  }
}
