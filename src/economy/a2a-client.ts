/**
 * A2A 1.0 client for an AIMarket hub — ARGUS finding and buying capabilities over the
 * standard agent protocol (aimarket-hub docs/a2a.md) instead of the hub's native REST.
 *
 * Deliberately thin: JSON-RPC over fetch, nothing else. What makes it an AIMarket client
 * rather than a generic one is how a paid call travels:
 *
 *  - with an owner's mandate, the invoke body is serialized ONCE, signed for
 *    `POST /ai-market/v2/invoke` with `MandateCredential.headers`, and sent as a raw
 *    `application/json` part holding those exact bytes — the proof covers the bytes, so a
 *    data part (re-serialized by whoever handles it) would fail as `mandate_proof_invalid`;
 *  - with a credit key, `X-API-Key` rides as an HTTP header and the invoke is a data part;
 *  - with neither, the hub runs the call on its free trial, or answers
 *    `TASK_STATE_INPUT_REQUIRED` with x402 terms (`paymentRequired`).
 *
 * The same `messageId` on a retried invoke returns the task the first attempt created — the
 * hub never runs (and charges) one message twice — so pass your own id when you will retry.
 */
import { randomUUID } from "node:crypto";
import type { MandateCredential } from "./aimarket-mandate.js";

export const A2A_VERSION = "1.0";
export const X402_EXTENSION = "https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2";
const INVOKE_PATH = "/ai-market/v2/invoke";
/** The path a mandate proof for a task READ covers: the hub's own view of /a2a (a proxy
 *  prefix, if any, is part of the mandate's hub origin already). */
const A2A_PATH = "/a2a";
/** A Pay-on-Verified invoke may be held by the hub for up to 300 s; giving up earlier and
 *  retrying under a NEW message id would pay twice. */
const DEFAULT_TIMEOUT_MS = 360_000;
/** Cap on an answer body (guards memory against a misbehaving endpoint). */
const MAX_ANSWER_BYTES = 2_000_000;

export interface A2APart {
  text?: string;
  raw?: string;
  data?: unknown;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: string; message?: A2AMessage; timestamp?: string };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

/** A JSON-RPC error answer: `code` (-32001 task not found, -32602 invalid params …) and the
 *  A2A `reason` (TASK_NOT_FOUND …). */
export class A2AError extends Error {
  constructor(readonly code: number, message: string, readonly reason: string) {
    super(`${code} ${reason || "error"}: ${message}`);
    this.name = "A2AError";
  }
}

export interface A2AClientOptions {
  hubUrl: string;
  /** A credit account on the hub (X-API-Key). Ignored when a mandate is set. */
  apiKey?: string;
  /** An owner-signed mandate for ARGUS's key: pays from the owner's account, under their limits. */
  mandate?: MandateCredential;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface InvokeOptions {
  productId?: string;
  sourceHub?: string;
  maxPriceUsd?: number;
  contextId?: string;
  messageId?: string;
}

function requireSecureHub(url: string): void {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(url)) {
    throw new Error(`hubUrl must be HTTPS (or localhost for dev): got "${url}"`);
  }
}

export class A2AClient {
  readonly hubUrl: string;
  private readonly o: A2AClientOptions;
  private nextId = 1;

  constructor(opts: A2AClientOptions) {
    this.hubUrl = opts.hubUrl.replace(/\/+$/, "");
    requireSecureHub(this.hubUrl);
    this.o = opts;
  }

  get endpoint(): string {
    return `${this.hubUrl}${A2A_PATH}`;
  }

  private async rpc(method: string, params: Record<string, unknown>, headers: (body: string) => Record<string, string>): Promise<any> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    const credentials = headers(body);
    if (method === "SendMessage" && this.o.mandate) {
      const proof = this.o.mandate.headers(body, "POST", A2A_PATH);
      const digest = proof["X-AIMarket-Mandate"];
      const signature = proof["X-AIMarket-Mandate-Proof"];
      if (!digest || !signature) throw new Error("mandate did not produce an A2A request proof");
      credentials["X-AIMarket-Mandate"] = digest;
      credentials["X-AIMarket-A2A-Proof"] = signature;
    }
    const res = await (this.o.fetch ?? fetch)(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": A2A_VERSION,
        "A2A-Extensions": X402_EXTENSION,
        ...credentials,
      },
      body,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) throw new A2AError(-32603, `answer exceeds ${MAX_ANSWER_BYTES} bytes`, "INVALID_RESPONSE");
    let answer: any;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new A2AError(-32603, `the hub answered HTTP ${res.status} without JSON`, "INVALID_RESPONSE");
    }
    if (answer?.error) {
      const reason = Array.isArray(answer.error.data) ? String(answer.error.data[0]?.reason ?? "") : "";
      throw new A2AError(Number(answer.error.code ?? -32603), String(answer.error.message ?? ""), reason);
    }
    if (!answer || typeof answer.result !== "object" || answer.result === null) {
      throw new A2AError(-32603, "the hub answered without a result", "INVALID_RESPONSE");
    }
    return answer.result;
  }

  /** `marketplace-search`: the hub's structured result (`matches` …). */
  async search(intent: string, opts: { limit?: number; budget?: number; category?: string } = {}): Promise<{ matches: any[] } & Record<string, unknown>> {
    const data: Record<string, unknown> = { intent, limit: opts.limit ?? 10 };
    if (opts.budget != null) data.budget = opts.budget;
    if (opts.category) data.category = opts.category;
    const message: A2AMessage = { messageId: randomUUID(), role: "ROLE_USER", parts: [{ data, mediaType: "application/json" }] };
    const result = await this.rpc("SendMessage", { message }, () => ({}));
    for (const part of (result.message?.parts ?? []) as A2APart[]) {
      if (part.data && typeof part.data === "object" && !Array.isArray(part.data)) {
        const found = part.data as Record<string, unknown>;
        return { ...found, matches: Array.isArray(found.matches) ? found.matches : [] };
      }
    }
    return { matches: [] };
  }

  /** `marketplace-invoke`: run one capability; resolves to the A2A Task. */
  async invoke(capabilityId: string, input: Record<string, unknown>, opts: InvokeOptions = {}): Promise<A2ATask> {
    const invoke: Record<string, unknown> = {
      product_id: opts.productId ?? capabilityId.split("@")[0],
      capability_id: capabilityId,
      source_hub: opts.sourceHub ?? "local",
      input,
    };
    if (opts.maxPriceUsd != null) invoke.max_price_usd = opts.maxPriceUsd;
    // Serialized once: these exact bytes are what a mandate proof signs.
    const raw = JSON.stringify(invoke);
    const mandate = this.o.mandate;
    const part: A2APart = mandate
      ? { raw: Buffer.from(raw, "utf8").toString("base64"), mediaType: "application/json" }
      : { data: { invoke }, mediaType: "application/json" };
    const message: A2AMessage = {
      messageId: opts.messageId ?? randomUUID(),
      role: "ROLE_USER",
      parts: [{ text: `invoke ${capabilityId}`, mediaType: "text/plain" }, part],
    };
    message.contextId = opts.contextId ?? message.messageId;
    const headers = (): Record<string, string> => {
      if (mandate) return mandate.headers(raw, "POST", INVOKE_PATH);
      return this.o.apiKey ? { "X-API-Key": this.o.apiKey } : {};
    };
    const result = await this.rpc("SendMessage", { message }, headers);
    return result.task as A2ATask;
  }

  /** Read a task back. A mandate proves itself with a fresh proof over this exact request. */
  async getTask(id: string): Promise<A2ATask> {
    return (await this.rpc("GetTask", { id }, (body) => this.readHeaders(body))) as A2ATask;
  }

  private readHeaders(body: string): Record<string, string> {
    if (this.o.mandate) return this.o.mandate.headers(body, "POST", A2A_PATH);
    return this.o.apiKey ? { "X-API-Key": this.o.apiKey } : {};
  }
}

export function taskState(task: A2ATask): string {
  return task?.status?.state ?? "";
}

export function statusMetadata(task: A2ATask): Record<string, unknown> {
  return (task?.status?.message?.metadata ?? {}) as Record<string, unknown>;
}

/** The status message's text: what the hub says happened, or what it needs. */
export function statusText(task: A2ATask): string {
  return (task?.status?.message?.parts ?? []).map((p) => p.text ?? "").filter(Boolean).join("\n");
}

/** The x402 PaymentRequired the hub quoted, when the task waits for a payment. */
export function paymentRequired(task: A2ATask): { accepts: Array<Record<string, unknown>> } & Record<string, unknown> | undefined {
  const terms = statusMetadata(task)["x402.payment.required"];
  return terms && typeof terms === "object" ? (terms as any) : undefined;
}

/** What the capability returned (the `result` artifact). */
export function taskResult(task: A2ATask): unknown {
  const artifact = (task?.artifacts ?? []).find((a) => a.name === "result" || a.artifactId === "result");
  const part = artifact?.parts?.[0];
  if (!part) return undefined;
  return "data" in part ? part.data : part.text;
}
