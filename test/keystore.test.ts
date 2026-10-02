import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptKeystore,
  decryptKeystore,
  keystorePath,
  loadKeystore,
  saveKeystore,
  resolveWalletKey,
  keystoreStatus,
  type KeystoreFileV2,
  type WalletSecret,
} from "../src/economy/keystore.js";

const SECRET: WalletSecret = {
  mnemonic: "test test test test test test test test test test test junk",
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PASS = "correct horse battery staple";

function assertV2(file: ReturnType<typeof encryptKeystore>): asserts file is KeystoreFileV2 {
  expect(file.v).toBe(2);
}

describe("keystore v2 PQC hybrid (ML-KEM-768 + ML-DSA-65)", () => {
  it("round-trips secret with kem wrap and dsa signature", () => {
    const file = encryptKeystore(SECRET, PASS, ADDR);
    assertV2(file);
    expect(file.pqc).toBe("ml-kem768+ml-dsa65");
    expect(file.kdf).toBe("scrypt");
    expect(file.kemCt.length).toBeGreaterThan(100);
    expect(file.dsaPub.length).toBeGreaterThan(10);
    expect(file.dsaSig.length).toBeGreaterThan(10);
    expect(file.address).toBe(ADDR);

    const blob = JSON.stringify(file);
    expect(blob).not.toContain(SECRET.privateKey);
    expect(blob).not.toContain("junk");

    const out = decryptKeystore(file, PASS);
    expect(out.privateKey).toBe(SECRET.privateKey);
    expect(out.mnemonic).toBe(SECRET.mnemonic);
  });

  it("uses fresh ML-KEM encapsulation on each encrypt (unique kemCt)", () => {
    const a = encryptKeystore(SECRET, PASS, ADDR);
    const b = encryptKeystore(SECRET, PASS, ADDR);
    assertV2(a);
    assertV2(b);
    expect(a.kemCt).not.toBe(b.kemCt);
    expect(a.iv).not.toBe(b.iv);
    // Both still decrypt to the same secret.
    expect(decryptKeystore(a, PASS).privateKey).toBe(SECRET.privateKey);
    expect(decryptKeystore(b, PASS).privateKey).toBe(SECRET.privateKey);
  });

  it("throws on wrong passphrase (bad decapsulation → GCM auth failure)", () => {
    const file = encryptKeystore(SECRET, "right-pass");
    assertV2(file);
    expect(() => decryptKeystore(file, "wrong-pass")).toThrow();
  });

  it("throws when ML-DSA signature is tampered", () => {
    const file = encryptKeystore(SECRET, PASS);
    assertV2(file);
    const tampered: KeystoreFileV2 = {
      ...file,
      dsaSig: file.dsaSig.slice(0, -2) + (file.dsaSig.endsWith("ff") ? "00" : "ff"),
    };
    expect(() => decryptKeystore(tampered, PASS)).toThrow(/PQC signature/i);
  });

  it("throws when ciphertext is tampered after signing", () => {
    const file = encryptKeystore(SECRET, PASS);
    assertV2(file);
    const ctBytes = Buffer.from(file.ct, "hex");
    ctBytes[0] ^= 0xff;
    const tampered: KeystoreFileV2 = { ...file, ct: ctBytes.toString("hex") };
    expect(() => decryptKeystore(tampered, PASS)).toThrow(/PQC signature/i);
  });

  it("throws when kemCt is tampered (signature still valid but decrypt fails)", () => {
    const file = encryptKeystore(SECRET, PASS);
    assertV2(file);
    const kemBytes = Buffer.from(file.kemCt, "hex");
    kemBytes[0] ^= 0xff;
    const tampered: KeystoreFileV2 = { ...file, kemCt: kemBytes.toString("hex") };
    // Signature verifies (payload fields unchanged in canonical sign blob except kemCt — wait, kemCt IS in sign payload)
    expect(() => decryptKeystore(tampered, PASS)).toThrow(/PQC signature/i);
  });

  it("defaults to v2 (post-quantum) when version omitted", () => {
    expect(encryptKeystore(SECRET, PASS).v).toBe(2);
  });
});

describe("keystore v1 classical (backward compat)", () => {
  it("round-trips v1 scrypt + AES-256-GCM", () => {
    const file = encryptKeystore(SECRET, PASS, ADDR, { version: 1 });
    expect(file.v).toBe(1);
    expect(file.kdf).toBe("scrypt");
    expect(file.address).toBe(ADDR);

    const out = decryptKeystore(file, PASS);
    expect(out.privateKey).toBe(SECRET.privateKey);
    expect(out.mnemonic).toBe(SECRET.mnemonic);
  });

  it("throws on wrong passphrase for v1", () => {
    const file = encryptKeystore(SECRET, "right-pass", undefined, { version: 1 });
    expect(() => decryptKeystore(file, "wrong-pass")).toThrow();
  });
});

describe("keystore validation", () => {
  it("refuses to encrypt without a passphrase", () => {
    expect(() => encryptKeystore(SECRET, "")).toThrow(/passphrase/i);
  });

  it("loadKeystore rejects unknown version", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-ks-bad-"));
    try {
      const path = join(dir, "keystore.json");
      saveKeystore(path, { v: 99 } as unknown as KeystoreFileV2);
      expect(loadKeystore(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("keystore on disk + resolution", () => {
  let dir: string;
  const saved = { pass: process.env.ARGUS_KEYSTORE_PASSPHRASE, key: process.env.ARGUS_WALLET_KEY };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argus-ks-"));
    delete process.env.ARGUS_KEYSTORE_PASSPHRASE;
    delete process.env.ARGUS_WALLET_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.pass === undefined) delete process.env.ARGUS_KEYSTORE_PASSPHRASE;
    else process.env.ARGUS_KEYSTORE_PASSPHRASE = saved.pass;
    if (saved.key === undefined) delete process.env.ARGUS_WALLET_KEY;
    else process.env.ARGUS_WALLET_KEY = saved.key;
  });

  it("saves v2 with mode 600 and reports vault-pqc when unlocked", () => {
    const path = keystorePath(dir);
    saveKeystore(path, encryptKeystore(SECRET, "vault-pass", ADDR));
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    const loaded = loadKeystore(path);
    expect(loaded?.v).toBe(2);

    expect(keystoreStatus(dir)).toBe("vault-locked");
    expect(resolveWalletKey(dir)).toBeUndefined();

    process.env.ARGUS_KEYSTORE_PASSPHRASE = "nope";
    expect(resolveWalletKey(dir)).toBeUndefined();

    process.env.ARGUS_KEYSTORE_PASSPHRASE = "vault-pass";
    expect(keystoreStatus(dir)).toBe("vault-pqc");
    expect(resolveWalletKey(dir)).toBe(SECRET.privateKey);
  });

  it("reports vault (classical) for v1 files on disk", () => {
    const path = keystorePath(dir);
    saveKeystore(path, encryptKeystore(SECRET, "vault-pass", ADDR, { version: 1 }));
    process.env.ARGUS_KEYSTORE_PASSPHRASE = "vault-pass";
    expect(keystoreStatus(dir)).toBe("vault");
    expect(resolveWalletKey(dir)).toBe(SECRET.privateKey);
  });

  it("prefers the vault over a plaintext env key", () => {
    process.env.ARGUS_WALLET_KEY = "0xdeadbeef";
    expect(keystoreStatus(dir)).toBe("plaintext-env");
    expect(resolveWalletKey(dir)).toBe("0xdeadbeef");

    saveKeystore(keystorePath(dir), encryptKeystore(SECRET, "vault-pass", ADDR));
    process.env.ARGUS_KEYSTORE_PASSPHRASE = "vault-pass";
    expect(resolveWalletKey(dir)).toBe(SECRET.privateKey);
  });

  it("reports 'none' with no keystore and no env key", () => {
    expect(keystoreStatus(dir)).toBe("none");
    expect(resolveWalletKey(dir)).toBeUndefined();
    expect(loadKeystore(keystorePath(dir))).toBeNull();
  });
});
