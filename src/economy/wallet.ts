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
 *
 * Idle-lock (R2): when ARGUS_WALLET_IDLE_LOCK_SEC is set, the wallet starts a
 * timer on construction. Every public operation resets the timer; when it fires,
 * the private key is zeroed out (`lock()`) and subsequent signing requests fail
 * with a clear "wallet locked" error. This shrinks the window where a memory
 * dump or compromised agent loop can extract the key. Operators who need
 * continuous uptime should set the lock to a generous value (e.g. 3600) rather
 * than leaving it unset; a locked wallet can be re-unlocked by re-running
 * `argus serve` or calling `wallet.unlock(newKey)` programmatically.
 */
export class Wallet {
  readonly address: string;
  private key: Hex | null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleSec: number;

  constructor(privateKeyHex: string) {
    const norm = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) {
      throw new Error("ARGUS_WALLET_KEY must be a 32-byte hex private key (64 hex chars, optional 0x).");
    }
    this.key = norm as Hex;
    this.address = privateKeyToAccount(this.key).address;

    // Idle-lock: auto-clear the key after N seconds of inactivity.
    // Set ARGUS_WALLET_IDLE_LOCK_SEC=0 or leave unset to disable.
    const idleRaw = Number(process.env.ARGUS_WALLET_IDLE_LOCK_SEC ?? "0");
    this.idleSec = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : 0;
    if (this.idleSec > 0) this.resetIdle();
  }

  /** Short display form, e.g. 0x1218…Ad0a. */
  get short(): string {
    return `${this.address.slice(0, 6)}…${this.address.slice(-4)}`;
  }

  /** The private key, or throws if the wallet has been locked. */
  get privateKey(): Hex {
    this.resetIdle();
    if (!this.key) throw new Error("wallet is LOCKED — key cleared from memory. Re-start argus with ARGUS_WALLET_KEY or unlock the keystore.");
    return this.key;
  }

  /** True when the key is still in memory and usable. */
  get locked(): boolean {
    return this.key === null;
  }

  /**
   * Explicitly zero the key from memory. Irreversible without re-providing the
   * key (via env, keystore, or unlock()).
   */
  lock(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.key = null;
  }

  /**
   * Re-load a key into a previously-locked wallet. The address MUST match the
   * original — you cannot change the identity of an existing wallet instance.
   */
  unlock(privateKeyHex: string): void {
    const norm = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) {
      throw new Error("wallet.unlock: key must be a 32-byte hex private key.");
    }
    const addr = privateKeyToAccount(norm as Hex).address;
    if (addr.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error("wallet.unlock: key does not match the original wallet address.");
    }
    this.key = norm as Hex;
    if (this.idleSec > 0) this.resetIdle();
  }

  /** Return the idle-lock configuration for status reporting. */
  idleConfig(): { enabled: boolean; idleSec: number } {
    return { enabled: this.idleSec > 0, idleSec: this.idleSec };
  }

  private resetIdle(): void {
    if (this.idleSec <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.lock(), this.idleSec * 1000);
    this.idleTimer.unref(); // don't keep the process alive just for the timer
  }

  /**
   * Generate a fresh Base wallet (BIP39 mnemonic → key → address). The caller
   * (the setup wizard) persists all three to the environment. The seed is NEVER
   * stored on the Wallet instance, logged, displayed, or passed to the model —
   * the agent only ever sees the public address.
   */
  static generate(): GeneratedWallet {
    const mnemonic = generateMnemonic(english);
    return Wallet.fromMnemonic(mnemonic);
  }

  /** Restore from an existing BIP39 seed phrase. */
  static fromMnemonic(mnemonic: string): GeneratedWallet {
    const normalized = mnemonic.trim().replace(/\s+/g, " ");
    const account = mnemonicToAccount(normalized);
    const hd = account.getHdKey();
    if (!hd.privateKey) throw new Error("failed to derive private key from mnemonic");
    return { mnemonic: normalized, privateKey: toHex(hd.privateKey), address: account.address };
  }
}
