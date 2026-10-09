import { createHash } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";

/**
 * ARGUS Passport — a portable, verifiable reputation card.
 *
 * The pitch: an agent's reputation should travel WITH it, not live trapped in one
 * platform's database. A Passport is a single self-describing object a counterparty
 * can read, render, and — crucially — *re-verify* without trusting ARGUS, the
 * network, or AICOM. It folds three reputation sources into one card:
 *   - LUMEN (PageRank-style trust score + rank, anchored by a graph commitment),
 *   - the Agent Arena (gamified track record: level / streak / win-rate / tasks),
 *   - on-chain earnings (USD settled to the agent's address).
 *
 * A Passport is "attested" only when it carries enough to be *checked*: an address
 * to bind it to, a LUMEN score, and a `graphCommitment` (the sha256 of the trust
 * graph LUMEN scored). When attested, `passportArtifact` emits a {type:"commitment"}
 * artifact over a canonical reputation pre-image, so a counterparty runs
 * `argus verify` and re-derives the same sha256 — turning a marketing card into a
 * proof. When NOT attested, the card renders in a clearly-labelled "local ·
 * unattested" mode and emits no artifact: a claim, never dressed up as a proof.
 *
 * This core is pure and dependency-free (only node:crypto). Everything it needs is
 * passed in, so it is trivially testable in isolation.
 */

/** Arena track-record summary folded into a Passport. */
export interface PassportArena {
  /** Arena level (>= 1). */
  level: number;
  /** Current daily streak. */
  streak: number;
  /** Win-rate as a fraction in [0, 1]. */
  winRate: number;
  /** Total tasks completed. */
  tasks: number;
}

/** Input to {@link buildPassport}. Optional fields degrade the card gracefully. */
export interface PassportInput {
  /** Agent handle, e.g. "argus". Required. */
  handle: string;
  /** On-chain address the reputation is bound to. Required for attestation. */
  address?: string;
  /** LUMEN trust score (typically in [0, 1]). Required for attestation. */
  lumenScore?: number;
  /** Human LUMEN rank label, e.g. "#3 of 142" or "top 2%". */
  lumenRank?: string;
  /** sha256 (hex) of the trust graph LUMEN scored. Required for attestation. */
  graphCommitment?: string;
  /** Arena track record. Required. */
  arena: PassportArena;
  /** Total USD earned/settled on-chain. */
  earnedUsd?: number;
}

/** A built, render-ready Passport. */
export interface Passport {
  /** Schema version of the pre-image format (bump on any canonical change). */
  version: 1;
  handle: string;
  address?: string;
  lumenScore?: number;
  lumenRank?: string;
  graphCommitment?: string;
  arena: PassportArena;
  earnedUsd: number;
  /** True iff address && lumenScore != null && graphCommitment are all present. */
  attested: boolean;
  /**
   * Canonical reputation pre-image — the exact string committed to. Present only
   * when attested; this is what `passportArtifact` hashes and what a verifier
   * recomputes. Stable, deterministic, field-ordered.
   */
  preimage?: string;
  /** sha256(preimage) (hex). Present only when attested. */
  commitment?: string;
}

/** Clamp a number into [0, 1]; non-finite inputs become 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Round to a fixed number of decimals deterministically (avoids -0 and drift). */
function round(n: number, dp: number): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  const r = Math.round(n * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * Build the canonical reputation pre-image. This is the cross-checkable contract:
 * a deterministic, field-ordered, pipe-delimited string. Anyone with the same
 * Passport facts derives the same string and thus the same sha256. Only called for
 * attested passports — address / lumenScore / graphCommitment are guaranteed here.
 */
function reputationPreimage(p: {
  handle: string;
  address: string;
  lumenScore: number;
  lumenRank: string;
  graphCommitment: string;
  arena: PassportArena;
  earnedUsd: number;
}): string {
  return [
    "argus-passport:v1",
    `handle:${p.handle}`,
    `address:${p.address.toLowerCase()}`,
    `lumen_score:${round(p.lumenScore, 6)}`,
    `lumen_rank:${p.lumenRank}`,
    `graph_commitment:${p.graphCommitment.toLowerCase()}`,
    `arena_level:${Math.trunc(p.arena.level)}`,
    `arena_streak:${Math.trunc(p.arena.streak)}`,
    `arena_win_rate:${round(clamp01(p.arena.winRate), 4)}`,
    `arena_tasks:${Math.trunc(p.arena.tasks)}`,
    `earned_usd:${round(p.earnedUsd, 2)}`,
  ].join("|");
}

/** sha256(s) as lowercase hex. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Build a Passport from raw reputation inputs.
 *
 * The card is `attested` iff it carries an `address`, a non-null `lumenScore`, and
 * a `graphCommitment` — the minimum needed for a counterparty to bind and re-verify
 * the reputation. When attested, a canonical `preimage` and its `commitment`
 * (sha256) are computed and embedded.
 */
export function buildPassport(input: PassportInput): Passport {
  const handle = input.handle;
  const arena: PassportArena = {
    level: Math.trunc(input.arena.level),
    streak: Math.trunc(input.arena.streak),
    winRate: clamp01(input.arena.winRate),
    tasks: Math.trunc(input.arena.tasks),
  };
  const earnedUsd = round(input.earnedUsd ?? 0, 2);

  const attested =
    typeof input.address === "string" &&
    input.address.length > 0 &&
    input.lumenScore != null &&
    Number.isFinite(input.lumenScore) &&
    typeof input.graphCommitment === "string" &&
    input.graphCommitment.length > 0;

  const passport: Passport = {
    version: 1,
    handle,
    arena,
    earnedUsd,
    attested,
  };

  // Carry through optional display fields regardless of attestation.
  if (input.address != null) passport.address = input.address;
  if (input.lumenScore != null && Number.isFinite(input.lumenScore)) passport.lumenScore = input.lumenScore;
  if (input.lumenRank != null) passport.lumenRank = input.lumenRank;
  if (input.graphCommitment != null) passport.graphCommitment = input.graphCommitment;

  if (attested) {
    // Narrowed by the `attested` guard above; assert presence for the pre-image.
    const preimage = reputationPreimage({
      handle,
      address: input.address as string,
      lumenScore: input.lumenScore as number,
      lumenRank: input.lumenRank ?? "",
      graphCommitment: input.graphCommitment as string,
      arena,
      earnedUsd,
    });
    passport.preimage = preimage;
    passport.commitment = sha256Hex(preimage);
  }

  return passport;
}

/** Approximate terminal display width: emoji are double-width; FE0F is zero. */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f) continue;
    w += cp >= 0x1f300 || cp === 0x2b50 ? 2 : 1;
  }
  return w;
}

/** Shorten an address/hash for display: 0x1234…cdef. */
function shorten(s: string): string {
  if (s.length <= 13) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Render a Passport as an ASCII card — the terminal/Telegram/SSH-safe view.
 *
 * When attested the LUMEN line shows the score (and rank, if present) and the card
 * is labelled with the verifiable commitment. When NOT attested the LUMEN line
 * reads "— (connect wallet)" and the card is labelled "local · unattested", so the
 * reader is never misled into treating an unverified card as a proof.
 */
export function renderPassport(p: Passport): string {
  const W = 48;
  const winPct = Math.round(p.arena.winRate * 100);
  const barFilled = Math.round((winPct / 100) * 10);
  const bar = "▰".repeat(barFilled) + "▱".repeat(10 - barFilled);

  const lumenLine = p.attested
    ? `🔮 LUMEN    ${(p.lumenScore ?? 0).toFixed(3)}${p.lumenRank ? `   ${p.lumenRank}` : ""}`
    : `🔮 LUMEN    — (connect wallet)`;

  const addrLine = p.address ? `🔗 Address  ${shorten(p.address)}` : `🔗 Address  — (connect wallet)`;

  const footer = p.attested
    ? `✔ verifiable · commit ${shorten(p.commitment ?? "")}`
    : `local · unattested`;

  const rows = [
    `ARGUS · PASSPORT             🪪`,
    `@${p.handle}`,
    "",
    addrLine,
    lumenLine,
    `🎯 Win-rate ${winPct}%   ${bar}   (${p.arena.tasks} tasks)`,
    `🏆 Arena    Lv ${p.arena.level}   🔥 ${p.arena.streak}d streak`,
    `💸 Earned   $${p.earnedUsd.toFixed(2)}`,
  ];

  const line = (c: string): string => c.repeat(W);
  const pad = (t: string): string => {
    const trailing = Math.max(0, W - 2 - visualWidth(t));
    return `║  ${t}${" ".repeat(trailing)}║`;
  };

  return [
    `╔${line("═")}╗`,
    ...rows.map(pad),
    `╟${line("─")}╢`,
    pad(footer),
    `╚${line("═")}╝`,
  ].join("\n");
}

/**
 * Produce a verifiable {type:"commitment"} artifact over the Passport's canonical
 * reputation pre-image, suitable for `argus verify` to re-check independently.
 *
 * Returns `null` when the Passport is not attested — an unattested card is a claim,
 * not a proof, and must not masquerade as one.
 */
export function passportArtifact(p: Passport): VerifiableArtifact | null {
  if (!p.attested || p.preimage == null || p.commitment == null) return null;
  return {
    type: "commitment",
    preimage: p.preimage,
    hash: p.commitment,
    label: `argus passport · @${p.handle}`,
  };
}
