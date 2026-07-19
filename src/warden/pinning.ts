import { createHash } from "node:crypto";
import type {
  McpServerRef,
  MemoryStore,
  PinnedServer,
  ToolDef,
  WardenFinding,
  WardenGate,
  WardenGateInput,
  WardenGateResult,
} from "../types.js";

/**
 * Tool-definition pinning + drift detection ("rug-pull" defence).
 *
 * A server can advertise benign tools at approval time and silently swap in a
 * poisoned definition later. We hash the canonical tool-def set on approval and
 * compare on every subsequent connection: a changed hash means the contract the
 * user approved no longer holds, so (under policy.pinToolDefs) we block and force
 * re-approval. First-contact servers are flagged UNPINNED so the chain knows the
 * pin is established only when the user approves.
 */
export class PinningGate implements WardenGate {
  readonly name = "pinning";

  constructor(private readonly store: MemoryStore) {}

  async evaluate(input: WardenGateInput): Promise<WardenGateResult> {
    const hash = canonicalToolsHash(input.tools);
    const pin = await this.store.getPin(input.server.id);

    if (!pin) {
      const finding: WardenFinding = {
        gate: this.name,
        severity: "info",
        code: "TOOL_DEF_UNPINNED",
        message: `Server "${input.server.id}" has no pinned tool-def snapshot yet; it will be pinned on approval.`,
      };
      // Neutral-to-good: unpinned isn't unsafe, it's just unestablished.
      return { findings: [finding], score: 0.9 };
    }

    if (pin.toolsHash !== hash) {
      const finding: WardenFinding = {
        gate: this.name,
        severity: "high",
        code: "TOOL_DEF_DRIFT",
        message:
          `Tool definitions for "${input.server.id}" changed since approval ` +
          `(pinned ${short(pin.toolsHash)} → now ${short(hash)}). Possible rug-pull; re-approval required.`,
      };
      return {
        findings: [finding],
        score: 0,
        fatal: input.policy.pinToolDefs === true,
      };
    }

    return { findings: [], score: 1 };
  }

  /**
   * Persist the current tool-def set as the trusted snapshot for this server.
   * Called by Warden.approve() once a user has accepted the connection.
   */
  async pin(server: McpServerRef, tools: ToolDef[]): Promise<void> {
    const pinned: PinnedServer = {
      serverId: server.id,
      toolsHash: canonicalToolsHash(tools),
      approvedAt: new Date().toISOString(),
      toolNames: [...tools.map((t) => t.name)].sort(),
    };
    await this.store.putPin(pinned);
  }
}

/**
 * sha256 over the canonical tool-def set. Canonicalisation: sort tools by name,
 * then serialise only the security-relevant fields (name, description, schema)
 * with sorted object keys so reordering or whitespace can't mask a real change.
 */
export function canonicalToolsHash(tools: ToolDef[]): string {
  const canonical = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    }));
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/** JSON.stringify with deterministically sorted object keys at every depth. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function short(hash: string): string {
  return hash.slice(0, 12);
}
