import { scryptSync, randomBytes, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import type { Logger } from "../types.js";

/** v1 — scrypt + AES-256-GCM (classical). v2 — hybrid ML-KEM-768 wrap + ML-DSA-65 integrity. */
export interface KeystoreFileV1 {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  ct: string;
  tag: string;
  address?: string;
}

export interface KeystoreFileV2 {
  v: 2;
  pqc: "ml-kem768+ml-dsa65";
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  kemCt: string;
  iv: string;
  ct: string;
  tag: string;
  dsaPub: string;
  dsaSig: string;
  address?: string;
}

export type KeystoreFile = KeystoreFileV1 | KeystoreFileV2;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SCRYPT_MASTER_LEN = 64;
const MAXMEM = 96 * 1024 * 1024;

export interface WalletSecret {
  mnemonic?: string;
  privateKey: string;
}

function scryptMaster(passphrase: string, salt: Buffer, file?: Pick<KeystoreFile, "N" | "r" | "p">): Buffer {
  const n = file?.N ?? N;
  const r = file?.r ?? R;
  const p = file?.p ?? P;
  return scryptSync(passphrase, salt, SCRYPT_MASTER_LEN, { N: n, r, p, maxmem: MAXMEM });
}

/** ML-DSA-65 keygen expects a 32-byte seed. */
function domainSeed32(master: Buffer, label: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", master).update(`argus-vault:${label}`).digest());
}

/** ML-KEM-768 keygen expects a 64-byte seed (32 for key pair + 32 for implicit-reject z). */
function domainSeed64(master: Buffer, label: string): Uint8Array {
  const h1 = createHmac("sha256", master).update(`argus-vault:${label}:a`).digest();
  const h2 = createHmac("sha256", master).update(`argus-vault:${label}:b`).digest();
  return new Uint8Array(Buffer.concat([h1, h2]));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function signPayloadV2(body: Omit<KeystoreFileV2, "dsaSig">): Uint8Array {
  const canonical = JSON.stringify({
    v: body.v,
    pqc: body.pqc,
    kdf: body.kdf,
    N: body.N,
    r: body.r,
    p: body.p,
    salt: body.salt,
    kemCt: body.kemCt,
    iv: body.iv,
    ct: body.ct,
    tag: body.tag,
    dsaPub: body.dsaPub,
    address: body.address ?? null,
  });
  return new TextEncoder().encode(canonical);
}

/** Default: v2 post-quantum hybrid vault. Pass `{ version: 1 }` for legacy classical-only. */
export function encryptKeystore(
  secret: WalletSecret,
  passphrase: string,
  address?: string,
  opts?: { version?: 1 | 2 },
): KeystoreFile {
  if (!passphrase) throw new Error("a passphrase is required to create a keystore");
  const version = opts?.version ?? 2;
  if (version === 1) return encryptKeystoreV1(secret, passphrase, address);
  return encryptKeystoreV2(secret, passphrase, address);
}

function encryptKeystoreV1(secret: WalletSecret, passphrase: string, address?: string): KeystoreFileV1 {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // AAD binds the KDF parameters to the ciphertext — an attacker with write access
  // cannot weaken scrypt (N/r/p) and re-encrypt without detection.
  const aad = Buffer.from(`argus-keystore:v1:scrypt:${N}:${R}:${P}:${salt.toString("hex")}:${iv.toString("hex")}`, "utf8");
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return {
    v: 1,
    kdf: "scrypt",
    N,
    r: R,
    p: P,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    address,
  };
}

function encryptKeystoreV2(secret: WalletSecret, passphrase: string, address?: string): KeystoreFileV2 {
  const salt = randomBytes(16);
  const master = scryptMaster(passphrase, salt);
  const kemKeys = ml_kem768.keygen(domainSeed64(master, "ml-kem768"));
  const dsaKeys = ml_dsa65.keygen(domainSeed32(master, "ml-dsa65"));
  const { cipherText: kemCtBytes, sharedSecret } = ml_kem768.encapsulate(kemKeys.publicKey);
  const aesKey = Buffer.from(sharedSecret).subarray(0, KEYLEN);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  // AAD binds the KDF parameters + kemCt to the GCM layer. The ML-DSA-65 signature
  // also covers the JSON body, so this is defense-in-depth.
  const aad = Buffer.from(`argus-keystore:v2:pqc:scrypt:${salt.toString("hex")}:${iv.toString("hex")}`, "utf8");
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  const body: Omit<KeystoreFileV2, "dsaSig"> = {
    v: 2,
    pqc: "ml-kem768+ml-dsa65",
    kdf: "scrypt",
    N,
    r: R,
    p: P,
    salt: salt.toString("hex"),
    kemCt: toHex(kemCtBytes),
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    dsaPub: toHex(dsaKeys.publicKey),
    address,
  };
  const dsaSig = toHex(ml_dsa65.sign(signPayloadV2(body), dsaKeys.secretKey));
  return { ...body, dsaSig };
}

/** Throws on a wrong passphrase, tampered file, or bad signature. */
export function decryptKeystore(file: KeystoreFile, passphrase: string): WalletSecret {
  if (file.v === 2) return decryptKeystoreV2(file, passphrase);
  return decryptKeystoreV1(file, passphrase);
}

function decryptKeystoreV1(file: KeystoreFileV1, passphrase: string): WalletSecret {
  const key = scryptSync(passphrase, Buffer.from(file.salt, "hex"), KEYLEN, {
    N: file.N,
    r: file.r,
    p: file.p,
    maxmem: MAXMEM,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
  decipher.setAuthTag(Buffer.from(file.tag, "hex"));
  // AAD must match encrypt — binds scrypt params to the ciphertext so parameter
  // weakening is detected as an auth failure.
  const aad = Buffer.from(`argus-keystore:v1:scrypt:${file.N}:${file.r}:${file.p}:${file.salt}:${file.iv}`, "utf8");
  decipher.setAAD(aad);
  const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, "hex")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as WalletSecret;
}

function decryptKeystoreV2(file: KeystoreFileV2, passphrase: string): WalletSecret {
  const { dsaSig, ...unsigned } = file;
  if (!ml_dsa65.verify(fromHex(dsaSig), signPayloadV2(unsigned), fromHex(file.dsaPub))) {
    throw new Error("keystore PQC signature verification failed (file tampered or corrupt)");
  }
  const master = scryptMaster(passphrase, Buffer.from(file.salt, "hex"), file);
  const kemKeys = ml_kem768.keygen(domainSeed64(master, "ml-kem768"));
  const sharedSecret = ml_kem768.decapsulate(fromHex(file.kemCt), kemKeys.secretKey);
  const aesKey = Buffer.from(sharedSecret).subarray(0, KEYLEN);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(file.iv, "hex"));
  decipher.setAuthTag(Buffer.from(file.tag, "hex"));
  const aad = Buffer.from(`argus-keystore:v2:pqc:scrypt:${file.salt}:${file.iv}`, "utf8");
  decipher.setAAD(aad);
  const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, "hex")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as WalletSecret;
}

export function keystorePath(stateDir: string): string {
  return join(expandHome(stateDir), "keystore.json");
}

export function loadKeystore(path: string): KeystoreFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as KeystoreFile;
    if (raw.v !== 1 && raw.v !== 2) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveKeystore(path: string, file: KeystoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

export function resolveWalletKey(stateDir: string, log?: Logger): string | undefined {
  const ks = loadKeystore(keystorePath(stateDir));
  if (ks) {
    const pass = process.env.ARGUS_KEYSTORE_PASSPHRASE;
    if (!pass) {
      log?.warn("encrypted keystore found but ARGUS_KEYSTORE_PASSPHRASE is not set — wallet stays LOCKED");
      return undefined;
    }
    try {
      return decryptKeystore(ks, pass).privateKey;
    } catch {
      log?.error("keystore unlock failed (wrong ARGUS_KEYSTORE_PASSPHRASE) — wallet stays LOCKED");
      return undefined;
    }
  }
  return process.env.ARGUS_WALLET_KEY?.trim() || undefined;
}

export type KeystoreStatus = "vault-pqc" | "vault" | "vault-locked" | "plaintext-env" | "none";

/** Is the wallet stored in an encrypted keystore (vs plaintext env)? */
export function keystoreStatus(stateDir: string): KeystoreStatus {
  const ks = loadKeystore(keystorePath(stateDir));
  if (ks) {
    if (!process.env.ARGUS_KEYSTORE_PASSPHRASE) return "vault-locked";
    return ks.v === 2 ? "vault-pqc" : "vault";
  }
  return process.env.ARGUS_WALLET_KEY ? "plaintext-env" : "none";
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
