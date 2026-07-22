import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

/** Parse `.env` text into key/value pairs (supports # comments and quoted values). */
export function parseEnvFile(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    m.set(key, unquoteEnvValue(t.slice(i + 1)));
  }
  return m;
}

function unquoteEnvValue(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  return v;
}

/** Candidate `.env` paths: explicit file → cwd → ARGUS_HOME / ~/.argus/agent. */
export function envFileCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string) => {
    const r = resolve(p);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  };
  if (process.env.ARGUS_ENV_FILE?.trim()) add(process.env.ARGUS_ENV_FILE.trim());
  add(resolve(process.cwd(), ".env"));
  const home = process.env.ARGUS_HOME?.trim() || join(homedir(), ".argus/agent");
  add(join(home, ".env"));
  return out;
}

/**
 * Load workspace secrets into `process.env`. Existing shell exports win;
 * later files only fill keys not already set.
 */
export function loadWorkspaceEnv(): string[] {
  const loaded: string[] = [];
  for (const path of envFileCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const vars = parseEnvFile(readFileSync(path, "utf8"));
      for (const [k, v] of vars) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      loaded.push(path);
    } catch {
      /* skip unreadable file */
    }
  }
  return loaded;
}
