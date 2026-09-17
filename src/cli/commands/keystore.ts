import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mnemonicToAccount } from "viem/accounts";
import { toHex } from "viem";
import type { ArgusConfig } from "../../config.js";
import {
  encryptKeystore,
  saveKeystore,
  keystorePath,
  loadKeystore,
  keystoreStatus,
  type WalletSecret,
} from "../../economy/keystore.js";
import { Wallet } from "../../economy/wallet.js";
import type { Args } from "../args.js";

export async function cmdKeystore(config: ArgusConfig, args: Args): Promise<number> {
  const sub = args.rest[0] ?? "create";
  const path = keystorePath(config.stateDir);

  if (sub === "address") {
    const ks = loadKeystore(path);
    if (!ks) {
      console.error(`No keystore at ${path}`);
      return 1;
    }
    console.log(ks.address ?? "(address not stored)");
    return 0;
  }
  if (sub !== "create" && sub !== "import") {
    console.error("Usage: argus keystore [create|import|address] [--force]");
    return 2;
  }
  if (loadKeystore(path) && !args.flags.force) {
    console.error(`Keystore already exists at ${path} — use --force to overwrite.`);
    return 1;
  }

  let pass = process.env.ARGUS_KEYSTORE_PASSPHRASE?.trim();
  let secret: WalletSecret;

  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const wantImport = sub === "import" || (await rl.question("Generate a NEW wallet or IMPORT a seed? [new/import] (new): ")).trim().toLowerCase().startsWith("i");
      if (wantImport) {
        const m = (await rl.question("Enter your 12/24-word seed phrase: ")).trim();
        secret = secretFromMnemonic(m);
      } else {
        const w = Wallet.generate();
        secret = { mnemonic: w.mnemonic, privateKey: w.privateKey };
      }
      if (!pass) {
        const p1 = await rl.question("New keystore passphrase: ");
        const p2 = await rl.question("Repeat passphrase: ");
        if (!p1 || p1 !== p2) {
          console.error("passphrases empty or do not match.");
          return 1;
        }
        pass = p1;
      }
    } finally {
      rl.close();
    }
  } else {
    if (!pass) {
      console.error("Non-interactive keystore create needs ARGUS_KEYSTORE_PASSPHRASE.");
      return 1;
    }
    const m = process.env.ARGUS_WALLET_MNEMONIC?.trim();
    const k = process.env.ARGUS_WALLET_KEY?.trim();
    if (m) {
      secret = secretFromMnemonic(m);
    } else if (k) {
      const pk = k.startsWith("0x") ? k : `0x${k}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        console.error(`Invalid ARGUS_WALLET_KEY: must be a 64-char hex private key (got ${k.length} chars).`);
        return 1;
      }
      secret = { privateKey: pk };
    } else {
      const w = Wallet.generate();
      secret = { mnemonic: w.mnemonic, privateKey: w.privateKey };
    }
  }

  const address = new Wallet(secret.privateKey).address;
  saveKeystore(path, encryptKeystore(secret, pass, address));
  console.log(`✅ Encrypted keystore written: ${path} (mode 600)`);
  console.log(`   vault: post-quantum hybrid (ML-KEM-768 + ML-DSA-65 + AES-256-GCM)`);
  console.log(`   address: ${address}`);
  console.log("   The seed/key are stored ENCRYPTED — never in plaintext.");
  console.log("   Unlock at runtime by setting ARGUS_KEYSTORE_PASSPHRASE (env / secret manager).");
  console.log("   ⚠ Back up the passphrase — without it the keystore CANNOT be decrypted.");
  console.log("   You can now remove ARGUS_WALLET_KEY / ARGUS_WALLET_MNEMONIC from .env.");
  return 0;
}

function secretFromMnemonic(mnemonic: string): WalletSecret {
  const hd = mnemonicToAccount(mnemonic).getHdKey();
  if (!hd.privateKey) throw new Error("could not derive a private key from that seed phrase");
  return { mnemonic, privateKey: toHex(hd.privateKey) };
}

export function keystoreLabel(stateDir: string): string {
  switch (keystoreStatus(stateDir)) {
    case "vault-pqc": return "🔒 PQC vault (ML-KEM-768 + ML-DSA-65, unlocked via ARGUS_KEYSTORE_PASSPHRASE)";
    case "vault": return "🔒 encrypted vault (v1 classical, unlocked via ARGUS_KEYSTORE_PASSPHRASE)";
    case "vault-locked": return "🔒 encrypted vault — LOCKED (set ARGUS_KEYSTORE_PASSPHRASE to unlock)";
    case "plaintext-env": return "⚠ plaintext ARGUS_WALLET_KEY (run `argus keystore create` to encrypt)";
    case "none": return "none (run `argus keystore create` to make an encrypted wallet)";
  }
}
