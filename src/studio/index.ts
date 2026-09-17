/**
 * Oracle Studio — friendly verbs over the seventeen AICOM oracles.
 *
 * Ideology: AICOM's most under-used asset is its own oracle family — most of it sits
 * idle because *using* it means knowing arcane capability ids (`platon.random@v1`,
 * `murmuration.aggregate@v1`, …) and their bespoke input shapes. Studio is the demand
 * ramp: it maps a human verb ("flip a fair coin", "how much to trust X", "will this
 * network shatter") to (a) the right capability id, (b) a `buildInput` that translates
 * friendly arguments into the capability's exact input contract, and (c) a `summarize`
 * that renders the signed output as one short human sentence.
 *
 * This core is PURE and CLIENT-AGNOSTIC. The network client is taken as a PARAMETER
 * to `runVerb`, so the registry is fully testable with a fake.
 */

import type { VerifiableArtifact } from "../verify/index.js";
import { field } from "./helpers.js";
import { STUDIO_VERBS } from "./registry.js";
import type { StudioClient, StudioVerb, VerbResult } from "./types.js";

export type { VerifiableArtifact, StudioClient, StudioVerb, VerbResult };
export { STUDIO_VERBS } from "./registry.js";

/** All known verb names. */
export function verbNames(): string[] {
  return Object.keys(STUDIO_VERBS);
}

/** Catalogue for menus / help: verb, capability id, and one-line description. */
export function listVerbs(): { verb: string; capabilityId: string; desc: string }[] {
  return Object.entries(STUDIO_VERBS).map(([verb, v]) => ({
    verb,
    capabilityId: v.capabilityId,
    desc: v.desc,
  }));
}

/** Resolve a verb (case-insensitive, tolerant of spaces/underscores → hyphen). */
export function resolveVerb(verb: string): StudioVerb | undefined {
  const direct = STUDIO_VERBS[verb];
  if (direct) return direct;
  const norm = verb.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return STUDIO_VERBS[norm];
}

/**
 * Run a Studio verb through an oracle client.
 *
 * @throws if the verb is unknown.
 */
export async function runVerb(
  client: StudioClient,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<VerbResult> {
  const entry = resolveVerb(verb);
  if (!entry) {
    throw new Error(`unknown studio verb "${verb}". Known verbs: ${verbNames().join(", ")}`);
  }
  const input = entry.buildInput(args);
  const res = await client.invoke(entry.capabilityId, input, entry.productId);
  const result: VerbResult = {
    verb,
    capabilityId: entry.capabilityId,
    answer: entry.summarize(res.output),
  };
  if (res.priceUsd !== undefined) result.priceUsd = res.priceUsd;
  if (res.receipt !== undefined) result.receipt = res.receipt;
  if (res.signerPublicKey !== undefined) result.signerPublicKey = res.signerPublicKey;
  return result;
}

/**
 * Map a verifiable VRF draw (from the `winner` verb's output) to one of `choices`.
 */
export function pickWinner<T>(output: unknown, choices: readonly T[]): T | undefined {
  if (choices.length === 0) return undefined;
  const hex = String(field(output, "random_hex") ?? "");
  if (hex.length === 0) return undefined;
  const draw = parseInt(hex.slice(0, 8), 16);
  if (!Number.isFinite(draw)) return undefined;
  const idx = ((draw % choices.length) + choices.length) % choices.length;
  return choices[idx];
}

/**
 * Build a `VerifiableArtifact` from a `runVerb` result for `verifyBundle`.
 */
export function toArtifact(result: VerbResult): VerifiableArtifact | undefined {
  if (!result.signerPublicKey || result.receipt === undefined) return undefined;
  if (typeof result.receipt !== "object" || result.receipt === null) return undefined;
  return {
    type: "oracle-receipt",
    receipt: result.receipt as Record<string, unknown>,
    signerPublicKey: result.signerPublicKey,
    label: `studio:${result.verb} (${result.capabilityId})`,
  };
}
