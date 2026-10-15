import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, type KeyObject } from "node:crypto";
import type { VerifiableArtifact } from "../verify/index.js";

/**
 * Sealed Approval Receipts — a hash-chained, tamper-evident consent log.
 *
 * Ideology: ARGUS's pitch is "auditable, not marketing". Before it runs a sensitive
 * tool call it should record *that consent was given*, for *which exact arguments*,
 * against *which exact set of pinned tools* — in a way no one can later rewrite,
 * reorder, or quietly delete. A flat log can be edited; a HASH CHAIN cannot, because
 * each entry commits to the one before it (`hash = sha256(prevHash + canonical(rec))`).
 * Change one byte of any past entry and every downstream link stops re-deriving, so
 * `verifyApprovalChain` points straight at the first broken index.
 *
 * This is a pure, append-only structure: `appendApproval` never mutates its input —
 * it returns a NEW array. No model, no network, no wallet. It works in full
 * crypto-off / offline mode by construction. An optional Ed25519 seal lets the
 * operator make the *head* of the chain non-repudiable (and emit it as a
 * `commitment` artifact re-checkable by `argus verify`), but the chain's integrity
 * itself needs no keys at all.
 */

/** The fields a caller supplies for one consent event (the signed-over payload). */
export interface ApprovalRecord {
  /** The tool whose invocation is being consented to (e.g. "wallet_transfer"). */
  tool: string;
  /** sha256 (hex) of the canonical arguments the tool will be called with. */
  argsHash: string;
  /** sha256 (hex) of the pinned tool-def set in force at consent time (WARDEN pin). */
  toolsHash: string;
  /** ISO-8601 timestamp of the consent decision. */
  timestamp: string;
}

/** One link in the consent chain: the record plus its chain linkage. */
export interface ApprovalEntry extends ApprovalRecord {
  /** Position in the chain, 0-based. Genesis is 0. */
  index: number;
  /** Hash of the previous entry; "0" for the genesis entry. */
  prevHash: string;
  /** `sha256(prevHash + canonical(record))` — this entry's content commitment. */
  hash: string;
}

/** Result of re-deriving and link-checking a whole chain. */
export interface ApprovalVerifyResult {
  /** True iff every entry re-derives and links correctly, with contiguous indices. */
  ok: boolean;
  /**
   * Index of the first entry that fails to re-derive or link. Absent when `ok`.
   * For a corrupted *genesis* this is 0.
   */
  brokenAt?: number;
}

/** The genesis previous-hash sentinel (the chain's anchor). */
export const GENESIS_PREV_HASH = "0";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Canonical, stable serialization of a record's *content fields only* (never the
 * linkage). Fixed field order + length-prefix framing means no value can be crafted
 * to collide with a different field layout (e.g. a "|" inside `tool`). This string is
 * exactly what each entry's hash — and any Ed25519 seal — commits to.
 */
export function canonicalApproval(rec: ApprovalRecord): string {
  const part = (k: string, v: string): string => `${k}=${v.length}:${v}`;
  return [
    part("tool", rec.tool),
    part("argsHash", rec.argsHash),
    part("toolsHash", rec.toolsHash),
    part("timestamp", rec.timestamp),
  ].join("|");
}

/**
 * Compute the content commitment for an entry given the previous entry's hash:
 * `sha256(prevHash + canonical(record))`.
 */
export function approvalHash(prevHash: string, rec: ApprovalRecord): string {
  return sha256Hex(prevHash + canonicalApproval(rec));
}

/**
 * Append one consent record to a chain, returning a NEW array (input untouched).
 *
 * The new entry links to the current head: `prevHash` = head's `hash` (or
 * {@link GENESIS_PREV_HASH} for the first entry), and `hash = sha256(prevHash +
 * canonical(rec))`. `index` is the next contiguous position.
 *
 * @param chain the existing chain (not mutated)
 * @param rec   the consent record to seal in
 * @returns a new chain with the entry appended
 */
export function appendApproval(chain: ApprovalEntry[], rec: ApprovalRecord): ApprovalEntry[] {
  const last = chain.length > 0 ? chain[chain.length - 1] : undefined;
  const prevHash = last?.hash ?? GENESIS_PREV_HASH;
  const index = last ? last.index + 1 : 0;
  const record: ApprovalRecord = {
    tool: rec.tool,
    argsHash: rec.argsHash,
    toolsHash: rec.toolsHash,
    timestamp: rec.timestamp,
  };
  const entry: ApprovalEntry = {
    ...record,
    index,
    prevHash,
    hash: approvalHash(prevHash, record),
  };
  return [...chain, entry];
}

/**
 * Re-derive every hash and check every link in a chain.
 *
 * For each position i the verifier recomputes `sha256(expectedPrev + canonical(rec))`
 * and requires it to equal the stored `hash`, that `prevHash` equals the prior
 * entry's stored hash (or {@link GENESIS_PREV_HASH} at genesis), and that `index`
 * is contiguous from 0. The first position failing ANY check is reported as
 * `brokenAt`. Tampering with a field, swapping a hash, reordering, or splicing
 * entries all surface here. An empty chain is vacuously `ok`.
 */
export function verifyApprovalChain(chain: ApprovalEntry[]): ApprovalVerifyResult {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    if (!e) return { ok: false, brokenAt: i };
    if (e.index !== i) return { ok: false, brokenAt: i };
    if (e.prevHash !== expectedPrev) return { ok: false, brokenAt: i };
    if (approvalHash(e.prevHash, e) !== e.hash) return { ok: false, brokenAt: i };
    expectedPrev = e.hash;
  }
  return { ok: true };
}

/** The current head hash of a chain (genesis sentinel for an empty chain). */
export function chainHead(chain: ApprovalEntry[]): string {
  const last = chain.length > 0 ? chain[chain.length - 1] : undefined;
  return last?.hash ?? GENESIS_PREV_HASH;
}

/**
 * A detached Ed25519 seal over a chain's head hash. Makes the *entire* chain
 * (which the head transitively commits to) non-repudiable by the holder of the key.
 */
export interface ChainSeal {
  /** The head hash that was signed (also the chain's tamper-evident summary). */
  head: string;
  /** Base64 Ed25519 signature over the head hash (UTF-8 bytes). */
  signature: string;
  /** Raw 32-byte Ed25519 public key, base64 — what a verifier checks against. */
  publicKey: string;
}

/** Export a Node Ed25519 public key as the raw-32-byte base64 form (oracle-core style). */
function rawPubB64(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("base64");
}

/** Build an Ed25519 public key object from a raw 32-byte base64 key, via SPKI DER. */
function ed25519FromRaw(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Seal a chain's head with an operator-supplied Ed25519 signer. The signer is taken
 * as a PARAMETER (not imported), so this core is testable in isolation and reusable
 * with any key source. The signed value is the head hash returned by {@link chainHead}.
 *
 * @param chain      the chain to seal (read-only)
 * @param privateKey an Ed25519 private KeyObject (e.g. from generateKeyPairSync("ed25519"))
 * @param publicKey  the matching Ed25519 public KeyObject (its raw form is embedded)
 */
export function sealChain(chain: ApprovalEntry[], privateKey: KeyObject, publicKey: KeyObject): ChainSeal {
  const head = chainHead(chain);
  const signature = nodeSign(null, Buffer.from(head, "utf8"), privateKey).toString("base64");
  return { head, signature, publicKey: rawPubB64(publicKey) };
}

/**
 * Verify a {@link ChainSeal} against a chain in one shot: the chain must itself be
 * intact, its current head must match the sealed head, and the Ed25519 signature must
 * check out. Any of the three failing returns false.
 */
export function verifySealedChain(chain: ApprovalEntry[], seal: ChainSeal): boolean {
  if (!verifyApprovalChain(chain).ok) return false;
  if (chainHead(chain) !== seal.head) return false;
  try {
    return nodeVerify(null, Buffer.from(seal.head, "utf8"), ed25519FromRaw(seal.publicKey), Buffer.from(seal.signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Convenience: mint a fresh Ed25519 keypair and seal a chain with it in one call.
 * Returns both the seal and the keys (so callers without an existing signer can still
 * produce a non-repudiable head). Pure wrapper over {@link sealChain}.
 */
export function generateAndSeal(chain: ApprovalEntry[]): { seal: ChainSeal; privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { seal: sealChain(chain, privateKey, publicKey), privateKey, publicKey };
}

/**
 * Project a chain's head into a `commitment` {@link VerifiableArtifact} so a third
 * party can re-check it with `argus verify`: the pre-image is the head's canonical
 * pre-image, the hash is the head itself. (Read-only; no signing.)
 *
 * The genesis entry's hash is `sha256("0" + canonical(genesisRecord))`, so we expose
 * the *last* entry's `prevHash + canonical(record)` as the pre-image of the head hash.
 */
export function headCommitment(chain: ApprovalEntry[], label?: string): VerifiableArtifact | null {
  const last = chain.length > 0 ? chain[chain.length - 1] : undefined;
  if (!last) return null;
  const preimage = last.prevHash + canonicalApproval(last);
  return { type: "commitment", preimage, hash: last.hash, label: label ?? `sealed approval head @${last.index}` };
}
