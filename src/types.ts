/**
 * ARGUS — shared type contract.
 *
 * Every module implements against the interfaces here. This file has no runtime
 * dependencies so it can be imported anywhere without side effects.
 */

// ─────────────────────────────────────────────────────────────────────────────
// LLM provider layer
// ─────────────────────────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** Present on assistant turns that request tools. */
  toolCalls?: ToolCall[];
  /** Present on `tool` turns — the id of the call being answered. */
  toolCallId?: string;
  /** Optional tool name on `tool` turns (some providers want it). */
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type JSONSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface LLMRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Hint: mark the stable prefix (system + tools) as cacheable. */
  cachePrefix?: boolean;
  signal?: AbortSignal;
}

export type StopReason = "stop" | "tool_use" | "length" | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (cheaper). */
  cachedInputTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  model: string;
}

export interface Provider {
  /** Stable id, e.g. "anthropic", "deepseek", "local". */
  readonly id: string;
  /** Wire family — determines request/response shaping. */
  readonly kind: ProviderKind;
  chat(req: LLMRequest): Promise<LLMResponse>;
}

export type ProviderKind = "anthropic" | "openai" | "local";

/** Pricing for the token meter. USD per 1M tokens. */
export interface Pricing {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
}

export type Tier = "triage" | "core" | "heavy";

// ─────────────────────────────────────────────────────────────────────────────
// Tools (agent-facing — built-in + MCP-bridged)
// ─────────────────────────────────────────────────────────────────────────────

export type ToolSource =
  | { kind: "builtin" }
  | { kind: "mcp"; server: string };

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Optional structured payload (not sent to the model verbatim). */
  data?: unknown;
}

export interface Tool {
  def: ToolDef;
  source: ToolSource;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  signal?: AbortSignal;
  /** True when the user has approved this specific sensitive call. */
  approved?: boolean;
  log: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget governor + token meter
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetLimits {
  /** Hard ceiling for a single task. Exceeding throws. */
  maxUsdPerTask?: number;
  maxTokensPerTask?: number;
  maxSteps?: number;
  maxToolCalls?: number;
}

export interface MeterSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  steps: number;
  toolCalls: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WARDEN — MCP security firewall
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerRef {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Optional catalog this server was discovered from. */
  catalog?: string;
}

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface WardenFinding {
  gate: string;
  severity: Severity;
  /** Stable machine code, e.g. "TOOL_DEF_INJECTION". */
  code: string;
  message: string;
  /** Optional tool the finding refers to. */
  tool?: string;
}

export interface WardenVerdict {
  allow: boolean;
  /** 0..1 composite safety score (1 = safe). */
  score: number;
  /** The gate that produced the final decision, if blocked. */
  decidedBy?: string;
  findings: WardenFinding[];
  /** Per-tool decisions when partial allow is in play. */
  allowedTools: string[];
  blockedTools: string[];
}

/** What a gate sees: the server + its advertised tools + accumulating state. */
export interface WardenGateInput {
  server: McpServerRef;
  tools: ToolDef[];
  /** Findings accumulated by earlier gates. */
  prior: WardenFinding[];
  policy: WardenPolicy;
}

export interface WardenGateResult {
  findings: WardenFinding[];
  /** Per-gate score contribution 0..1 (1 = this gate is satisfied). */
  score: number;
  /** If true, short-circuit the chain and block immediately. */
  fatal?: boolean;
}

export interface WardenGate {
  readonly name: string;
  evaluate(input: WardenGateInput): Promise<WardenGateResult>;
}

export interface WardenPolicy {
  /** Block servers below this LUMEN trust score (0..1). */
  minReputation: number;
  /** Block the whole connection if any finding >= this severity. */
  blockAtSeverity: Severity;
  /** Tool names that always require explicit user approval before running. */
  sensitiveToolPatterns: string[];
  /** Allow connecting to brand-new/unknown servers (no reputation yet). */
  allowUnknownServers: boolean;
  /** Re-approval required if a server's tool defs change after pinning. */
  pinToolDefs: boolean;
}

/** A pinned snapshot of a server's tools, used for drift detection. */
export interface PinnedServer {
  serverId: string;
  /** sha256 over the canonical tool-def set. */
  toolsHash: string;
  approvedAt: string;
  toolNames: string[];
}

/** A signed threat-intel record about a known-bad server/tool. */
export interface ThreatRecord {
  /** Pattern matched against server id/url/command. */
  pattern: string;
  severity: Severity;
  code: string;
  reason: string;
  source: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Economy (opt-in)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReputationScore {
  /** 0..1 PageRank/EigenTrust score from LUMEN. */
  score: number;
  /** 1 = highest. */
  rank?: number;
  percentile?: number;
  /** Hash commitment of the graph LUMEN scored. */
  graphCommitment?: string;
  /** True when the value is a safe default because the oracle was unreachable. */
  degraded: boolean;
}

export interface DiscoveredCapability {
  capabilityId: string;
  productId: string;
  name: string;
  description?: string;
  priceUsd: number;
  trustScore?: number;
  p50LatencyMs?: number;
  sourceHub?: string;
}

/** Pay-on-Verified outcome for one paid invoke — the hub's `verification` envelope
 *  (Metis verdict) plus the fields ARGUS surfaces in results and logging. */
export interface VerificationOutcome {
  /** Final envelope status ARGUS observed: "settled" | "refunded" | "pending" | "skipped". */
  status: string;
  /** Metis verdict; null while pending/skipped. */
  verified: boolean | null;
  /** Metis verify_score; null while pending/skipped. */
  verifyScore: number | null;
  /** Metis trace id — resolvable at GET /v1/traces/{trace_id} on the verifier. */
  traceId: string | null;
  /** True when the escrowed debit was released back to the buyer (failed verdict). */
  refunded: boolean;
  /** Receipt nonce — the lookup key at GET /ai-market/v2/verification/{nonce}. */
  nonce?: string;
  /** The hub's verification envelope, verbatim (Ed25519-signed once resolved). */
  envelope: Record<string, unknown>;
  /** Signed rejection receipt — present when the verdict failed and the debit was refunded. */
  rejectionReceipt?: Record<string, unknown>;
}

export interface InvokeOutcome {
  ok: boolean;
  output: unknown;
  priceUsd: number;
  receiptValid: boolean;
  latencyMs: number;
  error?: string;
  /** Pay-on-Verified verdict — present only when verified settlement was requested. */
  verification?: VerificationOutcome;
}

/** Demand side: discover, pay, invoke, settle. */
export interface EconomyConsumer {
  discover(intent: string, budgetUsd: number, limit?: number): Promise<DiscoveredCapability[]>;
  invoke(
    capabilityId: string,
    input: unknown,
    opts?: {
      productId?: string;
      sourceHub?: string;
      /** Buyer task description Metis judges the output against (Pay-on-Verified). */
      intent?: string;
    },
  ): Promise<InvokeOutcome>;
  settle(): Promise<{ refundedUsd: number; usedUsd: number }>;
}

/** Supply side: register identity + sell capabilities. */
export interface EconomyProvider {
  register(): Promise<{ agentId: string; trustScore: number; status: string }>;
  listCapability(cap: SellableCapability): Promise<{ capabilityId: string }>;
}

export interface SellableCapability {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  priceUsd: number;
}

/** Trust queries against the LUMEN oracle (used by WARDEN + economy). */
export interface TrustOracle {
  scoreEntity(entityId: string, edges?: TrustEdge[]): Promise<ReputationScore>;
}

/** [fromNodeIndex, toNodeIndex, weight] */
export type TrustEdge = [number, number, number];

// ─────────────────────────────────────────────────────────────────────────────
// Memory & self-learning
// ─────────────────────────────────────────────────────────────────────────────

export interface Episode {
  id: string;
  task: string;
  outcome: "success" | "failure" | "partial";
  summary: string;
  toolsUsed: string[];
  costUsd: number;
  createdAt: string;
  /** Provider id used for the core model (for the Arena "Polyglot" badge). */
  provider?: string;
}

export interface Lesson {
  id: string;
  /** Short retrieval key, e.g. "mcp:filesystem write outside root". */
  topic: string;
  text: string;
  /** Provenance episode ids. */
  from: string[];
  /** How often this lesson has been reinforced. */
  weight: number;
  createdAt: string;
}

export interface MemoryStore {
  addEpisode(e: Episode): Promise<void>;
  recentEpisodes(limit: number): Promise<Episode[]>;
  addLesson(l: Lesson): Promise<void>;
  /**
   * Upsert a lesson by topic: replaces an existing lesson with the same topic
   * (bumping its weight) or inserts a new one. Prevents duplicate accumulation
   * when the distiller reinforces the same topic across multiple calls.
   */
  upsertLesson(l: Lesson): Promise<void>;
  /** Cheap keyword retrieval of relevant lessons for a task. */
  recall(task: string, limit: number): Promise<Lesson[]>;
  getPin(serverId: string): Promise<PinnedServer | undefined>;
  putPin(p: PinnedServer): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, ...a: unknown[]): void;
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
  child(scope: string): Logger;
}
