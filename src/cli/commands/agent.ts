import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHash } from "node:crypto";
import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import { renderTrailer, toVerifyBundle } from "../../provenance/index.js";
import { buildAttestation, verifyAttestation } from "../../attest/index.js";
import { buildFrugalProof, toVerifiableArtifact, renderFrugalLine } from "../../frugalproof/index.js";
import { buildConscienceBundle } from "../../conscience/index.js";
import { sealSpendCert } from "../../spendcert/index.js";
import { sealVerifyCert, renderVerifyCertLine } from "../../verifycert/index.js";
import { declareSelfBond, type SelfBond } from "../../selfbond/index.js";
import { Wallet } from "../../economy/wallet.js";
import { OracleClient } from "../../economy/oracles.js";
import type { Args } from "../args.js";
import { makeApprover, meterLine, safeWrite } from "../util.js";

export async function cmdAsk(config: ArgusConfig, args: Args): Promise<number> {
  const task = args.rest.join(" ").trim();
  if (!task) {
    console.error('Usage: argus ask "your question"');
    return 2;
  }
  const log = createLogger("argus");
  // Pay-on-Verified (buyer opt-in): escrow each paid hub invoke until Metis verdicts
  // the output — pass captures the debit, fail refunds it. (Parser gotcha: keep
  // --verified AFTER the task text, or a following positional gets eaten as its value.)
  if (args.flags.verified) config.economy.verifyOutputs = true;
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Set an API key (e.g. ANTHROPIC_API_KEY) or run a local model (Ollama). Try `argus doctor`.");
    return 1;
  }
  const approve = makeApprover(Boolean(args.flags.yes));
  const agent = await rt.buildAgent(approve);
  const res = await agent.run(task);
  console.log(res.answer);
  console.error(`\n${renderTrailer(res.provenance)}`);
  console.error(`— ${meterLine(res.meter)} · ${res.outcome}`);
  if (typeof args.flags.provenance === "string") {
    const bundle = toVerifyBundle(res.provenance);
    safeWrite(args.flags.provenance, JSON.stringify(bundle, null, 2), config.stateDir);
    console.error(`provenance bundle → ${args.flags.provenance}  (re-check: argus verify ${args.flags.provenance})`);
  }
  const a = res.audit;
  if (a.approvals.count > 0) console.error(`consent · ${a.approvals.count} sealed approval(s) · chain ${a.approvals.intact ? "intact ✓" : "BROKEN ✕"}`);
  // Pay-on-Verified outcome per hire (verified/refunded/score/trace) — surfaced even
  // without --conscience so a refund is never silent.
  if (a.verifications.length) {
    console.error(renderVerifyCertLine(sealVerifyCert(a.verifications, a.session.endedAt)));
    for (const v of a.verifications) {
      console.error(
        `  · ${v.capabilityId} — ${v.status}${v.refunded ? " (refunded)" : ""} · score ${v.verifyScore ?? "?"} · trace ${v.traceId ?? "?"}`,
      );
    }
  }
  if (a.drift.length) console.error(`⚠ behavioral drift · ${a.drift.map((d) => `${d.tool}: ${d.reasons.join(", ")}`).join(" · ")}`);
  if (typeof args.flags.attest === "string") {
    const att = buildAttestation({ session: a.session });
    safeWrite(args.flags.attest, JSON.stringify(att, null, 2), config.stateDir);
    console.error(`negative attestation → ${args.flags.attest}  (claims: ${att.claims.join(", ") || "none"}; verifies: ${verifyAttestation(att)})`);
  }
  if (typeof args.flags.frugalproof === "string") {
    const m = res.meter;
    const client = new OracleClient(config.economy.oracleFamilyUrl, log.child("oracle"));
    const proof = await buildFrugalProof({
      snapshot: { tokensIn: m.inputTokens, tokensOut: m.outputTokens, steps: m.steps, costUsd: m.costUsd },
      taskHash: createHash("sha256").update(task).digest("hex"),
      modelTier: config.models.core.ref,
      client,
    });
    safeWrite(args.flags.frugalproof, JSON.stringify([toVerifiableArtifact(proof)], null, 2), config.stateDir);
    console.error(`${renderFrugalLine(proof)}  → ${args.flags.frugalproof}`);
  }
  if (typeof args.flags.conscience === "string") {
    // The verifiable conscience: every proof this run emitted, folded into ONE bundle a
    // stranger re-checks offline with `argus verify` — oracle receipts + frugal-cost +
    // consent chain + negative attestation. Trust nothing; refute it.
    const m = res.meter;
    const client = new OracleClient(config.economy.oracleFamilyUrl, log.child("oracle"));
    const frugalProof = await buildFrugalProof({
      snapshot: { tokensIn: m.inputTokens, tokensOut: m.outputTokens, steps: m.steps, costUsd: m.costUsd },
      taskHash: createHash("sha256").update(task).digest("hex"),
      modelTier: config.models.core.ref,
      client,
    });
    // Spend-cert: certify every subcontract bought the cheapest trustworthy option shown.
    const spendCert = a.spend.length > 0 ? sealSpendCert(a.spend, a.session.endedAt) : undefined;
    // Verify-cert: persist every Pay-on-Verified verdict envelope (+ rejection receipts) verbatim.
    const verifyCert = a.verifications.length > 0 ? sealVerifyCert(a.verifications, a.session.endedAt) : undefined;
    // Self-bond: stake ARGUS's own frugality/conduct to its wallet identity (opt-in; OFF unless
    // a wallet is present AND ARGUS_SELF_BOND_USD>0). Pure declaration — no funds move, enforced=false.
    let selfBond: SelfBond | undefined;
    if (config.economy.walletKey && config.economy.bondUsd > 0) {
      try {
        const evmAddress = new Wallet(config.economy.walletKey).address;
        selfBond = declareSelfBond({
          taskHash: createHash("sha256").update(task).digest("hex"),
          agentId: `self:${evmAddress}`,
          evmAddress,
          chain: config.economy.chain,
          bondUsd: config.economy.bondUsd,
          token: config.economy.token,
          penaltyRate: config.economy.penaltyRate,
          bondedCeilingUsd: a.mandate.budgetUsd,
          actualSpendUsd: m.costUsd,
          frugalDigest: frugalProof.digest,
          attestationCanonical: buildAttestation({ session: a.session }).canonical,
          mandateCommitment: a.mandate.commitment,
          sealedAt: a.session.endedAt,
        });
      } catch (err) {
        log.debug(`self-bond skipped: ${(err as Error).message}`);
      }
    }
    const bundle = buildConscienceBundle({
      mandate: a.mandate,
      provenance: res.provenance,
      frugalProof,
      spendCert,
      verifyCert,
      selfBond,
      attestation: buildAttestation({ session: a.session }),
      consentChain: a.chain.length > 0 ? { chain: a.chain } : undefined,
    });
    safeWrite(args.flags.conscience, JSON.stringify(bundle, null, 2), config.stateDir);
    console.error(`conscience bundle → ${args.flags.conscience}  (${bundle.artifacts.length} proof artifact(s) · re-check: argus verify ${args.flags.conscience})`);
  }
  await rt.dispose();
  return res.outcome === "failure" ? 1 : 0;
}

export async function cmdChat(config: ArgusConfig, args: Args): Promise<number> {
  const log = createLogger("argus");
  // Same buyer opt-in as cmdAsk: chat sessions can hire too.
  if (args.flags.verified) config.economy.verifyOutputs = true;
  const rt = await Runtime.create(config, log);
  if (!rt.router.available) {
    console.error("No LLM provider configured. Try `argus doctor`.");
    return 1;
  }
  const approve = makeApprover(Boolean(args.flags.yes));
  const agent = await rt.buildAgent(approve);
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("ARGUS chat — Ctrl-D or 'exit' to quit.\n");
  try {
    for (;;) {
      const task = (await rl.question("you › ")).trim();
      if (!task) continue;
      if (task === "exit" || task === "quit") break;
      const res = await agent.run(task);
      console.log(`\nargus › ${res.answer}\n`);
      console.error(`${renderTrailer(res.provenance)}\n— ${meterLine(res.meter)}\n`);
    }
  } catch {
    /* EOF */
  } finally {
    rl.close();
    await rt.dispose();
  }
  return 0;
}
