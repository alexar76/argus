import { writeFileSync } from "node:fs";
import type { ArgusConfig } from "../../config.js";
import { AgentKey, issueMandate, mandateDigest, MandateCredential, requestProof, PROOF_HEADER } from "../../economy/aimarket-mandate.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import type { Args } from "../args.js";

const USAGE = `Usage:
  argus mandate keygen                       new agent key: prints the did:key an owner issues a mandate to
  argus mandate status                       validity, chain and spend of the mandate ARGUS pays with
  argus mandate delegate --to <did:key> --per-call <usd> --per-day <usd> [--scope a.*,b@v1] [--total <usd>] [--days 7] [--out file]
                                             re-delegate part of ARGUS's mandate to a sub-agent (always narrower)`;

/** `argus mandate …` — the agent side of aimarket-protocol/mandates.md. */
export async function cmdMandate(config: ArgusConfig, args: Args): Promise<number> {
  const sub = args.rest[0] ?? "status";

  if (sub === "keygen") {
    const key = AgentKey.generate();
    console.log(`did:key   ${key.did}`);
    console.log(`secret    ${key.seedHex()}`);
    console.log("");
    console.log("Put the secret in your .env as ARGUS_AGENT_KEY=<secret> (never commit it). Give the did:key");
    console.log("to the owner: they issue a mandate to it (aimarket-agent: issue_mandate) and register it at the");
    console.log("hub; save the mandate JSON and point ARGUS_MANDATE_FILE at it.");
    return 0;
  }

  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  try {
    const mandate = rt.mandate();
    if (!mandate) {
      console.error("No mandate configured: set ARGUS_MANDATE_FILE and ARGUS_AGENT_KEY.");
      return 1;
    }
    const hub = config.economy.hubUrl.replace(/\/+$/, "");

    if (sub === "status") {
      const path = `/ai-market/v2/mandates/${mandate.digest}`;
      const res = await fetch(`${hub}${path}`, {
        headers: { [PROOF_HEADER]: requestProof(mandate.key, { hubOrigin: hub, leafDigest: mandate.digest, body: "", method: "GET", path }) },
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`hub answered ${res.status}: ${body.error ?? ""} ${body.detail ?? ""}`.trim());
        return 1;
      }
      console.log(`mandate   ${mandate.digest}  (${body.status})`);
      console.log(`agent     ${mandate.key.did}`);
      console.log(`issuer    ${body.issuer}${body.depth ? `  (re-delegation, depth ${body.depth})` : "  (the owner)"}`);
      console.log(`valid     ${body.valid_from} → ${body.valid_until}`);
      const limits = mandate.limitsUsd();
      console.log(`limits    ${Object.entries(limits).map(([k, v]) => `${k} $${v}`).join(" · ")}`);
      if (body.usage) {
        const u = body.usage;
        console.log(`today     $${u.spent_today_usd} of $${u.per_day_usd}  (left $${u.remaining_today_usd})`);
        console.log(`total     $${u.spent_total_usd}${u.total_usd != null ? ` of $${u.total_usd}` : ""}`);
      }
      return 0;
    }

    if (sub === "delegate") {
      const to = String(args.flags.to ?? "");
      if (!to.startsWith("did:key:")) {
        console.error(USAGE);
        return 2;
      }
      const num = (name: string): number | undefined => (args.flags[name] != null ? Number(args.flags[name]) : undefined);
      const perCall = num("per-call");
      const perDay = num("per-day");
      if (perCall == null || perDay == null || !(perCall > 0) || !(perDay > 0)) {
        console.error("--per-call and --per-day are required (USD).");
        return 2;
      }
      const parentBody = ((mandate.document.credentialSubject as any).aimarketMandate ?? {}) as Record<string, any>;
      const scope = args.flags.scope ? String(args.flags.scope).split(",").map((s) => s.trim()).filter(Boolean) : parentBody.scope;
      const child = issueMandate(mandate.key, to, {
        audience: parentBody.audience,
        scope,
        perCallUsd: perCall,
        perDayUsd: perDay,
        totalUsd: num("total"),
        validDays: num("days") ?? 7,
        parent: mandate.document,
      });
      const res = await fetch(`${hub}/ai-market/v2/mandates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(child),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`the hub refused the re-delegation: ${res.status} ${body.error ?? ""} — ${body.detail ?? ""}`);
        return 1;
      }
      const out = String(args.flags.out ?? `mandate-${mandateDigest(child).slice(7, 19).replace(/[/+]/g, "_")}.json`);
      writeFileSync(out, `${JSON.stringify(child, null, 2)}\n`, { mode: 0o600 });
      console.log(`delegated ${body.digest} → ${to}  (saved to ${out})`);
      return 0;
    }

    console.error(USAGE);
    return 2;
  } finally {
    await rt.dispose();
  }
}

// Re-exported for tests.
export { MandateCredential };
