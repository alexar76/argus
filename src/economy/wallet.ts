import { privateKeyToAccount, generateMnemonic, mnemonicToAccount, english } from "viem/accounts";
import { toHex, type Hex } from "viem";

export interface GeneratedWallet {
  /** BIP39 seed phrase — written ONLY to the environment, NEVER logged, displayed, or sent to the model. */
  mnemonic: string;
  privateKey: Hex;
  address: string;
}

/**
 * Thin wallet wrapper. The heavy lifting (EIP-712 DebitAuthorization signing for
 * the AIMarketEscrow) is done by the `@aimarket/agent` SDK given the same key;
 * here we only derive the public address for identity / Mesh registration and
 * validate the key shape early so failures are friendly, not cryptic.
 */
export class Wallet {
  readonly address: string;
  private readonly key: Hex;

  constructor(privateKeyHex: string) {
    const norm = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) {
      throw new Error("ARGUS_WALLET_KEY must be a 32-byte hex private key (64 hex chars, optional 0x).");
    }
    this.key = norm as Hex;
    this.address = privateKeyToAccount(this.key).address;
  }

  /** Short display form, e.g. 0x1218…Ad0a. */
  get short(): string {
    return `${this.address.slice(0, 6)}…${this.address.slice(-4)}`;
  }

  /**
   * Generate a fresh Base wallet (BIP39 mnemonic → key → address). The caller
   * (the setup wizard) persists all three to the environment. The seed is NEVER
   * stored on the Wallet instance, logged, displayed, or passed to the model —
   * the agent only ever sees the public address.
   */
  static generate(): GeneratedWallet {
    const mnemonic = generateMnemonic(english);
    const account = mnemonicToAccount(mnemonic);
    const hd = account.getHdKey();
    if (!hd.privateKey) throw new Error("failed to derive private key from mnemonic");
    return { mnemonic, privateKey: toHex(hd.privateKey), address: account.address };
  }
}
