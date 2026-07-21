import { readFileSync } from "node:fs";
import { verifyBundle } from "../../verify/index.js";
import type { Args } from "../args.js";

export async function cmdVerify(args: Args): Promise<number> {
  const file = args.rest[0];
  if (!file) {
    console.error("Usage: argus verify <bundle.json>     (or pipe JSON: … | argus verify -)");
    console.error("Re-checks ARGUS proof bundles LOCALLY — Ed25519 receipt signatures, sha256");
    console.error("commitments, WARDEN tool-def hashes. No network, no wallet. A failing proof");
    console.error("was a claim, not a proof.");
    return 2;
  }
  let raw: string;
  try {
    raw = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (err) {
    console.error(`cannot read ${file}: ${(err as Error).message}`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`not valid JSON: ${(err as Error).message}`);
    return 2;
  }
  const report = verifyBundle(parsed);
  for (const c of report.claims) console.log(`${c.ok ? "✓" : "✕"} ${c.label} — ${c.detail}`);
  const passed = report.claims.filter((c) => c.ok).length;
  console.log(`\n${report.ok ? "✅ all proofs verified" : "❌ verification FAILED"}  (${passed}/${report.claims.length})`);
  console.error("offline · no network · no wallet — re-checked locally with public keys + sha256");
  return report.ok ? 0 : 1;
}
