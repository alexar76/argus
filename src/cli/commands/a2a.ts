import type { ArgusConfig } from "../../config.js";
import { A2AClient, A2AError, paymentRequired, statusMetadata, statusText, taskResult, taskState } from "../../economy/a2a-client.js";
import type { MandateCredential } from "../../economy/aimarket-mandate.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import type { Args } from "../args.js";

const USAGE = `Usage:
  argus a2a search "<intent>" [--limit 5] [--budget <usd>]
                                             find capabilities over the hub's A2A endpoint
  argus a2a invoke <capability_id> --input '<json>' [--product <id>] [--source-hub <url>] [--max-price <usd>]
                                             buy and run one: pays with the owner's mandate
                                             (ARGUS_MANDATE_FILE + ARGUS_AGENT_KEY), else ARGUS_HUB_API_KEY,
                                             else the hub's free trial
  argus a2a task <task_id>                   read a task back`;

/** The mandate ARGUS pays with, loaded the way every other paid path loads it — or null
 *  without building a runtime at all when none is configured. */
async function loadMandate(config: ArgusConfig): Promise<MandateCredential | null> {
  if (!config.economy.mandateFile || !config.economy.agentKeySeedHex) return null;
  const rt = await Runtime.create(config, createLogger("argus", "error"));
  try {
    return rt.mandate();
  } finally {
    await rt.dispose();
  }
}

function num(value: string | boolean | undefined): number | undefined {
  if (value == null || value === true) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `argus a2a …` — the hub over A2A 1.0 (aimarket-hub docs/a2a.md). */
export async function cmdA2A(config: ArgusConfig, args: Args): Promise<number> {
  const sub = args.rest[0];
  const hubUrl = config.economy.hubUrl;
  try {
    if (sub === "search") {
      const intent = args.rest.slice(1).join(" ").trim();
      if (!intent) {
        console.error(USAGE);
        return 2;
      }
      const client = new A2AClient({ hubUrl });
      const found = await client.search(intent, { limit: num(args.flags.limit) ?? 5, budget: num(args.flags.budget) });
      if (!found.matches.length) {
        console.log(`no offers for "${intent}"`);
        return 0;
      }
      for (const m of found.matches) {
        const price = m.routed_price_usd ?? m.price_per_call_usd ?? 0;
        console.log(`${m.capability_id}  $${price}  product=${m.product_id}  source_hub=${m.source_hub ?? "local"}`);
        if (m.description) console.log(`    ${String(m.description).slice(0, 160)}`);
      }
      return 0;
    }

    if (sub === "invoke") {
      const capability = args.rest[1];
      if (!capability) {
        console.error(USAGE);
        return 2;
      }
      let input: Record<string, unknown> = {};
      if (typeof args.flags.input === "string") {
        try {
          const parsed = JSON.parse(args.flags.input);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          input = parsed as Record<string, unknown>;
        } catch (err) {
          console.error(`--input must be a JSON object: ${(err as Error).message}`);
          return 2;
        }
      }
      const mandate = await loadMandate(config);
      const apiKey = process.env.ARGUS_HUB_API_KEY?.trim() || undefined;
      const client = new A2AClient({ hubUrl, mandate: mandate ?? undefined, apiKey: mandate ? undefined : apiKey });
      const task = await client.invoke(capability, input, {
        productId: typeof args.flags.product === "string" ? args.flags.product : undefined,
        sourceHub: typeof args.flags["source-hub"] === "string" ? args.flags["source-hub"] : undefined,
        maxPriceUsd: num(args.flags["max-price"]),
      });
      return report(task, mandate ? "mandate" : apiKey ? "credits" : "trial/unpaid");
    }

    if (sub === "task") {
      const id = args.rest[1];
      if (!id) {
        console.error(USAGE);
        return 2;
      }
      const mandate = await loadMandate(config);
      const apiKey = process.env.ARGUS_HUB_API_KEY?.trim() || undefined;
      const client = new A2AClient({ hubUrl, mandate: mandate ?? undefined, apiKey: mandate ? undefined : apiKey });
      return report(await client.getTask(id), "");
    }

    console.error(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof A2AError) {
      console.error(`hub refused: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

function report(task: Parameters<typeof taskState>[0], rail: string): number {
  const state = taskState(task);
  console.log(`task      ${task.id}  (${state.replace("TASK_STATE_", "").toLowerCase()})${rail ? `  paid via ${rail}` : ""}`);
  if (state === "TASK_STATE_COMPLETED") {
    const aimarket = (task.metadata?.aimarket ?? {}) as Record<string, unknown>;
    if (aimarket.price_usd != null) console.log(`price     $${aimarket.price_usd}`);
    console.log(JSON.stringify(taskResult(task), null, 2));
    return 0;
  }
  const terms = paymentRequired(task);
  if (terms) {
    const offer = terms.accepts?.[0] ?? {};
    console.log(`x402      ${offer.amount} atomic units of ${offer.asset} to ${offer.payTo} on ${offer.network}`);
  }
  const why = statusText(task);
  if (why) console.log(why);
  const detail = (statusMetadata(task).aimarket ?? {}) as Record<string, unknown>;
  if (detail.error) console.log(`error     ${detail.error}${detail.limit ? ` (${detail.limit})` : ""}`);
  return 1;
}
