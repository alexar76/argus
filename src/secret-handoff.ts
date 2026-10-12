/**
 * Keep secrets out of ARGUS's exec-time environment.
 *
 * ARGUS spawns third-party MCP servers with an allow-listed environment, so a child never
 * RECEIVES a key. That is not the same as a child being unable to READ one. A process's
 * exec-time environment stays readable to every other process of the same user for as
 * long as it runs: `/proc/<pid>/environ` on Linux, `sysctl(KERN_PROCARGS2)` on macOS. A
 * stdio MCP server is exactly such a process, so it could read ARGUS_WALLET_KEY, the
 * keystore passphrase and every provider key out of its parent. Verified 2026-10-11 on the
 * production container (12 secret names readable from /proc/1/environ as uid node) and on
 * macOS, where `sandbox-exec` does not stop the sysctl either.
 *
 * The fix is to not have them there. At startup, before anything is spawned, ARGUS moves
 * every secret-looking variable into a private file, re-executes itself in place
 * (`process.execve`: same pid, so a service manager or a container sees nothing change)
 * with an environment that no longer carries them, then reads the file back into
 * `process.env`, deletes it, and carries on. Values set on `process.env` live in the heap,
 * not in the exec-time block those interfaces read, so the rest of ARGUS is unchanged.
 *
 * Fail-soft: without `process.execve` (Node < 22.15, Windows), with the escape hatch
 * ARGUS_SECRET_HANDOFF=0, or on any error, ARGUS runs exactly as before and says why.
 */
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, statSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Names that carry credentials. Moving a harmless one costs nothing: every value comes back. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD|PASSWD|SEED|MNEMONIC|PRIVATE|CREDENTIAL|COOKIE|AUTH)/i;
/** Set in the re-executed image; names the file to read back. */
export const HANDOFF_VAR = "ARGUS_SECRET_HANDOFF_FILE";
/** The escape hatch: ARGUS_SECRET_HANDOFF=0 keeps the old behaviour. */
const SWITCH_VAR = "ARGUS_SECRET_HANDOFF";
/** Set alongside it so a failure to read back can never turn into an exec loop. */
const DONE_VAR = "ARGUS_SECRET_HANDOFF_DONE";
const DIR_PREFIX = "argus-handoff-";

export type HandoffState =
  | { state: "moved"; count: number }
  | { state: "clean" }
  | { state: "skipped"; reason: string };

let lastState: HandoffState = { state: "skipped", reason: "not run" };

/** What happened at startup, for `argus doctor`. */
export function secretHandoffState(): HandoffState {
  return lastState;
}

export function secretNames(env: NodeJS.ProcessEnv): string[] {
  const own = new Set([HANDOFF_VAR, DONE_VAR, SWITCH_VAR]);
  return Object.keys(env).filter((k) => SECRET_NAME.test(k) && !own.has(k) && env[k] !== undefined && env[k] !== "");
}

/** Split an environment into what stays in the exec-time block and what moves out. */
export function splitEnv(env: NodeJS.ProcessEnv): { keep: Record<string, string>; move: Record<string, string> } {
  const move: Record<string, string> = {};
  const keep: Record<string, string> = {};
  const secret = new Set(secretNames(env));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (secret.has(k)) move[k] = v;
    else keep[k] = v;
  }
  return { keep, move };
}

type ExecFn = (file: string, args: string[], env: Record<string, string>) => never;

interface HandoffDeps {
  env?: NodeJS.ProcessEnv;
  execve?: ExecFn | undefined;
  platform?: NodeJS.Platform;
  argv?: string[];
  execArgv?: string[];
  execPath?: string;
  tmp?: string;
  uid?: number;
}

/**
 * Run once, first thing in the process. Either returns (nothing to do, read back, or
 * skipped) or replaces the process image and never returns.
 */
export function moveSecretsOutOfExecEnv(deps: HandoffDeps = {}): HandoffState {
  const env = deps.env ?? process.env;
  const handoff = env[HANDOFF_VAR];
  if (handoff) {
    lastState = readBack(handoff, env, deps.uid ?? process.getuid?.());
    return lastState;
  }
  if (env[DONE_VAR]) return (lastState = { state: "clean" });
  if ((env[SWITCH_VAR] ?? "").trim() === "0") {
    return (lastState = { state: "skipped", reason: `${SWITCH_VAR}=0` });
  }
  const { keep, move } = splitEnv(env);
  const count = Object.keys(move).length;
  if (count === 0) return (lastState = { state: "clean" });
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return (lastState = { state: "skipped", reason: "not supported on Windows" });
  const execve = "execve" in deps ? deps.execve : (process as unknown as { execve?: ExecFn }).execve?.bind(process);
  if (typeof execve !== "function") {
    return (lastState = { state: "skipped", reason: "process.execve unavailable (needs Node >= 22.15)" });
  }

  let dir = "";
  let file = "";
  try {
    dir = mkdtempSync(join(deps.tmp ?? tmpdir(), DIR_PREFIX));
    file = join(dir, "env.json");
    writeFileSync(file, JSON.stringify(move), { mode: 0o600, flag: "wx" });
  } catch (err) {
    cleanup(file, dir);
    return (lastState = { state: "skipped", reason: `could not write the handoff file: ${(err as Error).message}` });
  }
  const execPath = deps.execPath ?? process.execPath;
  const argv = deps.argv ?? process.argv;
  const execArgv = deps.execArgv ?? process.execArgv;
  try {
    execve(execPath, [execPath, ...execArgv, ...argv.slice(1)], { ...keep, [HANDOFF_VAR]: file, [DONE_VAR]: "1" });
  } catch (err) {
    cleanup(file, dir);
    return (lastState = { state: "skipped", reason: `re-exec failed: ${(err as Error).message}` });
  }
  // A real execve does not return; a test double might.
  return (lastState = { state: "moved", count });
}

function readBack(file: string, env: NodeJS.ProcessEnv, uid: number | undefined): HandoffState {
  delete env[HANDOFF_VAR];
  const dir = dirname(file);
  try {
    // Only a file this process's previous image could have written: a private directory
    // of ours, a regular file, mode 0600. Anything else is somebody else's file and is
    // neither read nor deleted.
    if (!basename(dir).startsWith(DIR_PREFIX) || basename(file) !== "env.json") throw new Error("unexpected path");
    const st = lstatSync(file);
    if (!st.isFile()) throw new Error("not a regular file");
    if (uid !== undefined && st.uid !== uid) throw new Error("not owned by this user");
    if ((st.mode & 0o077) !== 0) throw new Error("readable by others");
    if (uid !== undefined && statSync(dir).uid !== uid) throw new Error("directory not owned by this user");
    const values = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    let count = 0;
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === "string" && SECRET_NAME.test(k)) { env[k] = v; count++; }
    }
    cleanup(file, dir);
    return { state: "moved", count };
  } catch (err) {
    return { state: "skipped", reason: `handoff file refused (${(err as Error).message}); secrets from the original environment are unavailable` };
  }
}

function cleanup(file: string, dir: string): void {
  try { if (file) unlinkSync(file); } catch { /* already gone */ }
  try { if (dir) rmdirSync(dir); } catch { /* already gone */ }
}

/** One line for `argus doctor`. */
export function secretHandoffLabel(state: HandoffState = lastState): string {
  switch (state.state) {
    case "moved":
      return `${state.count} secret variable(s) kept out of the exec-time environment (child processes cannot read them via /proc or sysctl)`;
    case "clean":
      return "no secrets in the exec-time environment";
    default:
      return `NOT applied — ${state.reason}; a child process of this user can read secrets from ARGUS's environment`;
  }
}
