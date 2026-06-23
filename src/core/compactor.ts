import type { Logger, Message } from "../types.js";
import type { ProviderRouter } from "../providers/router.js";

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
    log.debug(`compacted ${head.length} messages → summary (${res.usage.outputTokens} tok)`);
    const summary: Message = { role: "user", content: `[earlier conversation summary]\n${res.content}` };
    return [summary, ...tail];
  } catch (err) {
    log.debug(`compaction skipped: ${(err as Error).message}`);
    return messages;
  }
}
