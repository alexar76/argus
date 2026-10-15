import type { VerifiableArtifact } from "../verify/index.js";

/** Re-exported so callers can hand a runVerb result straight to `argus verify`. */
export type { VerifiableArtifact };

/** Minimal contract Studio needs from an oracle-family client (e.g. OracleClient). */
export interface StudioClient {
  invoke(
    capabilityId: string,
    input: unknown,
    productId?: string,
  ): Promise<{ output: unknown; priceUsd?: number; receipt?: unknown; signerPublicKey?: string }>;
}

/** One human verb bound to one oracle capability. */
export interface StudioVerb {
  readonly capabilityId: string;
  readonly productId?: string;
  readonly desc: string;
  buildInput(args: Record<string, unknown>): object;
  summarize(output: unknown): string;
}

/** What `runVerb` returns: the human answer plus the proof passthrough. */
export interface VerbResult {
  verb: string;
  capabilityId: string;
  answer: string;
  priceUsd?: number;
  receipt?: unknown;
  signerPublicKey?: string;
}
