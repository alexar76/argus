import type { EconomyProvider, Logger, SellableCapability } from "../types.js";

/** Max bytes for a mesh API response. */
const MAX_MESH_BODY = 128_000;

/** Max bytes for a mesh error body. */
const MAX_MESH_ERROR_BODY = 1024;

export interface MeshProviderOptions {
  meshUrl: string;
  /** Path of the agent-registry endpoint on the mesh service. */
  agentsPath?: string;
  name: string;
  /** EVM address (0x…) bound as the agent's wallet identity. */
  evmAddress?: string;
  /** Public endpoint for the agent; HTTPS required by the mesh except localhost. */
  endpointUrl?: string;
  /** Optional bearer token for mesh authentication. */
  authToken?: string;
  log: Logger;
  timeoutMs?: number;
}

/** Ensure a URL is HTTPS (or localhost for dev). */
function requireSecureMeshUrl(url: string, label: string): void {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(url)) {
    throw new Error(`${label} must be HTTPS (or localhost for dev): got "${url}"`);
  }
}

/** Validate Content-Type header before calling .json(). */
function checkJsonContent(res: Response, label: string): void {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json") && !ct.includes("+json")) {
    throw new Error(`${label}: expected JSON but got "${ct}"`);
  }
}

/** Read a bounded slice of a response body for error reporting. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, MAX_MESH_ERROR_BODY);
  } catch {
    return "(body unreadable)";
  }
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
  private readonly authToken?: string;

  constructor(private readonly o: MeshProviderOptions) {
    this.base = o.meshUrl.replace(/\/$/, "");
    requireSecureMeshUrl(this.base, "meshUrl");
    // Validate endpoint_url if provided — must be HTTPS for production registrations.
    if (o.endpointUrl) requireSecureMeshUrl(o.endpointUrl, "endpointUrl");
    this.authToken = o.authToken?.trim() || undefined;
    this.agentsPath = o.agentsPath ?? "/v1/agents";
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
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.authToken) headers["authorization"] = `Bearer ${this.authToken}`;
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`mesh HTTP ${res.status}: ${await readErrorBody(res)}`);
      // Size guard before parsing JSON.
      const cl = res.headers.get("content-length");
      if (cl && Number(cl) > MAX_MESH_BODY) {
        throw new Error(`mesh response too large: content-length ${cl} exceeds ${MAX_MESH_BODY} bytes`);
      }
      checkJsonContent(res, "mesh");
      return (await res.json()) as Record<string, any>;
    } finally {
      clearTimeout(timer);
    }
  }
}
