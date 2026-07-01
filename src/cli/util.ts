import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ApprovalRequest } from "../core/agent.js";
import type { MeterSnapshot } from "../types.js";

export const VERSION = "0.2.0";

/**
 * Restricted file-write helper — only allows writes to cwd or stateDir.
 *
 * Symlink defence (H1): resolves the real path of every ancestor directory that
 * exists, then re-joins the remainder, so a symlink inside stateDir pointing
 * outside it cannot be used to escape the boundary. The final target must not
 * exist (we are creating it) so the leaf is NOT resolved — only existing
 * ancestors are. This closes the symlink-based path-traversal vector while
 * still allowing writes to new paths inside the allowed trees.
 */
export function safeWrite(dest: string, data: string, stateDir: string): void {
  const abs = resolve(dest);

  // Resolve symlinks in the deepest existing ancestor, then re-join the
  // non-existent suffix. This catches `stateDir/symlink → /etc/write-here`.
  let existent = abs;
  while (existent !== "/" && !existsSync(existent)) {
    existent = dirname(existent);
  }
  const real = existent !== "/" || existsSync("/") ? realpathSync(existent) : existent;
  const resolved = existent === abs ? real : `${real}${abs.slice(existent.length)}`;

  const cwd = resolve(process.cwd());
  const std = resolve(stateDir);
  // Use resolved paths for the boundary check so symlink escapes are detected.
  if (!resolved.startsWith(cwd + "/") && !resolved.startsWith(std + "/") && resolved !== cwd && resolved !== std) {
    throw new Error(`Refusing to write outside cwd (${cwd}) or state dir (${std}): ${dest}`);
  }
  writeFileSync(abs, data);
}

export function makeApprover(autoYes: boolean) {
  return async (req: ApprovalRequest): Promise<boolean> => {
    if (autoYes) return true;
    if (!stdin.isTTY) return false;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const where = req.server ? ` (server ${req.server})` : "";
      const ans = (await rl.question(`⚠ approve sensitive tool "${req.tool}"${where}? [y/N] `)).trim().toLowerCase();
      return ans === "y" || ans === "yes";
    } finally {
      rl.close();
    }
  };
}

export function meterLine(m: MeterSnapshot): string {
  const cacheRate = m.inputTokens ? Math.round((m.cachedTokens / m.inputTokens) * 100) : 0;
  return `tok ${m.inputTokens}/${m.outputTokens} (cache ${cacheRate}%) · ${m.steps} steps · ${m.toolCalls} tools · $${m.costUsd.toFixed(4)}`;
}

export function printFindings(findings: { severity: string; code: string; message: string; tool?: string }[]): void {
  for (const f of findings) {
    if (f.severity === "info") continue;
    console.log(`    [${f.severity}] ${f.code}${f.tool ? ` (${f.tool})` : ""}: ${f.message}`);
  }
}
