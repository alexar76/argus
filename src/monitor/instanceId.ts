import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "monitor-instance-id";

/**
 * Stable per-agent id for Alien Monitor roster (ARGUS · N).
 *
 * When a wallet is set, id is derived from it so live + UNI containers
 * (separate state dirs) coalesce into one fleet row.
 */
export function loadOrCreateInstanceId(stateDir: string, wallet?: string): string {
  if (wallet?.startsWith("0x") && wallet.length >= 12) {
    return `argus-${createHash("sha256").update(wallet.toLowerCase()).digest("hex").slice(0, 16)}`;
  }
  const dir = stateDir.replace(/\/+$/, "");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const path = join(dir, FILE);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (/^[a-zA-Z0-9_.:-]{4,128}$/.test(raw)) return raw;
    } catch {
      /* fall through */
    }
  }
  const id = `argus-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
  } catch {
    /* ephemeral ok */
  }
  return id;
}
