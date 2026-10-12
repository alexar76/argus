import type { Logger, Message } from "../types.js";
import type { ProviderRouter } from "../providers/router.js";

/**
 * Injection-signature patterns for compactor output sanitisation (M4 fix).
 * The triage model's output is LLM-authored → untrusted. Before it is folded
 * back into the core model's context, we check it for instruction-override
 * language, system-prompt references, and forced-behaviour directives. A match
 * drops the compacted summary and falls back to a safe truncation marker.
 */
const COMPACTOR_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bignore\s+(previous|above|all|prior)\s+(instructions?|constraints?|rules?|context)\b/i,
  /\byou\s+are\s+(now|no\s+longer)\b/i,
  /\bdisregard\s+(all|previous|above|prior)\b/i,
  /\boverride\s+(all|previous|system|above)\b/i,
  /\bpretend\s+(you\s+are|to\s+be)\b/i,
  /\byou\s+are\s+(an?\s+)?(AI|GPT|Claude|model|assistant|agent)\b/i,
  /\byour\s+(new\s+)?identity\s+(is|:)/i,
  /\byou\s+(must|should|shall)\s+(always|never)\b/i,
  /\bdo\s+not\s+follow\s+(your|previous|above)\b/i,
  /\bsystem\s+(prompt|message|instruction|rule)s?\b/i,
  /\bforget\s+(everything|all)\s+(you|above|before)\b/i,
  /\bthis\s+is\s+(now\s+)?your\s+(new\s+)?(prompt|instruction|rule|directive)\b/i,
];

function containsInjectionPayload(text: string): boolean {
  for (const p of COMPACTOR_INJECTION_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}

/** Rough token estimate (chars/4) — good enough to decide when to compact. */
export function estimateTokens(messages: Message[], system?: string): number {
  let chars = system?.length ?? 0;
  for (const m of messages) {
    chars += m.content.length;
    for (const tc of m.toolCalls ?? []) chars += JSON.stringify(tc.arguments).length + tc.name.length;
  }
  return Math.ceil(chars / 4);
}

export interface CompactOptions {
  /** Compact when the estimate exceeds this many tokens. */
  thresholdTokens?: number;
  /** Always keep this many of the most recent messages verbatim. */
  keepLast?: number;
}

/**
 * Context compaction. When a task runs long, summarise the OLDEST messages into
 * a single note on the cheap (triage) model and keep only recent turns verbatim.
 * This caps the context window so cost per step stays flat instead of growing
 * quadratically — a core token-economy lever and the opposite of letting an
 * unbounded transcript balloon every step.
 */
export async function compact(
  messages: Message[],
  router: ProviderRouter,
  log: Logger,
  system?: string,
  opts: CompactOptions = {},
): Promise<Message[]> {
  const threshold = opts.thresholdTokens ?? 16_000;
  const keepLast = opts.keepLast ?? 6;
  if (messages.length <= keepLast + 2) return messages;
  if (estimateTokens(messages, system) < threshold) return messages;

  const head = messages.slice(0, messages.length - keepLast);
  const tail = messages.slice(messages.length - keepLast);

  // Never split a tool result from its assistant tool_call: if the first kept
  // message is a tool result, pull one more message into the head.
  if (tail[0]?.role === "tool") {
    head.push(tail.shift()!);
  }

  const transcript = head
    .map((m) => `${m.role.toUpperCase()}: ${m.content}${m.toolCalls?.length ? ` [calls: ${m.toolCalls.map((c) => c.name).join(", ")}]` : ""}`)
    .join("\n");

  try {
    const res = await router.chat("triage", {
      system: "You compress agent transcripts. Output a terse factual summary preserving decisions, findings, file paths, and open threads. No preamble.",
      messages: [{ role: "user", content: `Summarise the earlier conversation:\n\n${transcript}` }],
      maxTokens: 512,
      temperature: 0,
    });
    // M4 fix: sanitise triage-model output before injecting it into the core
    // model's context. A compromised triage provider could otherwise inject
    // prompt-override language through the compaction path.
    if (containsInjectionPayload(res.content)) {
      log.warn(`compaction output matched injection patterns — discarding summary, using safe truncation`);
      const trunc: Message = { role: "user", content: `[${head.length} earlier messages truncated for length]` };
      return [trunc, ...tail];
    }
    log.debug(`compacted ${head.length} messages → summary (${res.usage.outputTokens} tok)`);
    const summary: Message = { role: "user", content: `[earlier conversation summary]\n${res.content}` };
    return [summary, ...tail];
  } catch (err) {
    log.debug(`compaction skipped: ${(err as Error).message}`);
    return messages;
  }
}
