import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_VAR, moveSecretsOutOfExecEnv, secretNames, splitEnv } from "../src/secret-handoff.js";

/**
 * A process's exec-time environment is readable by every other process of the same user
 * (/proc/<pid>/environ, sysctl KERN_PROCARGS2). A stdio MCP server is such a process, so
 * the allow-list that keeps keys out of its OWN environment did not keep them out of its
 * reach: it could read ARGUS_WALLET_KEY straight out of its parent. ARGUS now re-executes
 * itself without them and keeps the values only in the heap.
 */

type Captured = { file: string; args: string[]; env: Record<string, string> };

function fakeExec(): { exec: (f: string, a: string[], e: Record<string, string>) => never; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    exec: ((file: string, args: string[], env: Record<string, string>) => {
      calls.push({ file, args, env });
      return undefined as never;
    }) as (f: string, a: string[], e: Record<string, string>) => never,
  };
}

describe("secret handoff", () => {
  it("classifies credentials by name and leaves ordinary variables alone", () => {
    const env = { PATH: "/bin", HOME: "/h", ARGUS_WALLET_KEY: "k", ANTHROPIC_API_KEY: "a", ARGUS_KEYSTORE_PASSPHRASE: "p", ARGUS_HTTP_TOKEN: "t", LANG: "C", EMPTY_TOKEN: "" };
    expect(secretNames(env).sort()).toEqual(["ANTHROPIC_API_KEY", "ARGUS_HTTP_TOKEN", "ARGUS_KEYSTORE_PASSPHRASE", "ARGUS_WALLET_KEY"]);
    const { keep, move } = splitEnv(env);
    expect(Object.keys(keep).sort()).toEqual(["EMPTY_TOKEN", "HOME", "LANG", "PATH"]);
    expect(move.ARGUS_WALLET_KEY).toBe("k");
  });

  it("re-executes with the secrets moved into a private file, then reads them back and deletes it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "argus-ho-test-"));
    const env: NodeJS.ProcessEnv = { PATH: "/bin", ARGUS_WALLET_KEY: "0xabc", DEEPSEEK_API_KEY: "sk-1" };
    const { exec, calls } = fakeExec();
    const first = moveSecretsOutOfExecEnv({ env, execve: exec, platform: "linux", argv: ["node", "/app/dist/index.js", "serve"], execArgv: ["--enable-source-maps"], execPath: "/usr/bin/node", tmp });
    expect(first.state).toBe("moved");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    // Same program, same arguments, node flags preserved.
    expect(call.args).toEqual(["/usr/bin/node", "--enable-source-maps", "/app/dist/index.js", "serve"]);
    // The new exec-time environment carries no secret, only where to find them.
    expect(call.env.ARGUS_WALLET_KEY).toBeUndefined();
    expect(call.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(call.env.PATH).toBe("/bin");
    const file = call.env[HANDOFF_VAR];
    expect(existsSync(file)).toBe(true);

    // The re-executed image.
    const env2: NodeJS.ProcessEnv = { ...call.env };
    const second = moveSecretsOutOfExecEnv({ env: env2, execve: exec, uid: process.getuid?.() });
    expect(second).toEqual({ state: "moved", count: 2 });
    expect(env2.ARGUS_WALLET_KEY).toBe("0xabc");
    expect(env2.DEEPSEEK_API_KEY).toBe("sk-1");
    expect(env2[HANDOFF_VAR]).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
    expect(calls).toHaveLength(1); // no second exec
  });

  it("refuses a handoff file another user could have written or read", () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-handoff-"));
    const file = join(dir, "env.json");
    writeFileSync(file, JSON.stringify({ ARGUS_WALLET_KEY: "planted" }), { mode: 0o644 });
    chmodSync(file, 0o644);
    const env: NodeJS.ProcessEnv = { [HANDOFF_VAR]: file, ARGUS_SECRET_HANDOFF_DONE: "1" };
    const r = moveSecretsOutOfExecEnv({ env, uid: process.getuid?.() });
    expect(r.state).toBe("skipped");
    expect(env.ARGUS_WALLET_KEY).toBeUndefined();
    expect(existsSync(file)).toBe(true); // not ours to delete
  });

  it("refuses a handoff path outside its own directory naming", () => {
    const dir = mkdtempSync(join(tmpdir(), "elsewhere-"));
    mkdirSync(join(dir, "x"));
    const file = join(dir, "env.json");
    writeFileSync(file, JSON.stringify({ ARGUS_WALLET_KEY: "planted" }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { [HANDOFF_VAR]: file };
    expect(moveSecretsOutOfExecEnv({ env, uid: process.getuid?.() }).state).toBe("skipped");
    expect(env.ARGUS_WALLET_KEY).toBeUndefined();
  });

  it("is a no-op without secrets, with the escape hatch, on Windows, or without execve", () => {
    const { exec, calls } = fakeExec();
    expect(moveSecretsOutOfExecEnv({ env: { PATH: "/bin" }, execve: exec, platform: "linux" }).state).toBe("clean");
    expect(moveSecretsOutOfExecEnv({ env: { ARGUS_WALLET_KEY: "k", ARGUS_SECRET_HANDOFF: "0" }, execve: exec, platform: "linux" }).state).toBe("skipped");
    expect(moveSecretsOutOfExecEnv({ env: { ARGUS_WALLET_KEY: "k" }, execve: exec, platform: "win32" }).state).toBe("skipped");
    expect(moveSecretsOutOfExecEnv({ env: { ARGUS_WALLET_KEY: "k" }, execve: undefined, platform: "linux" }).state).toBe("skipped");
    // A failed read-back can never loop: the re-executed image is marked done.
    expect(moveSecretsOutOfExecEnv({ env: { ARGUS_WALLET_KEY: "k", ARGUS_SECRET_HANDOFF_DONE: "1" }, execve: exec, platform: "linux" }).state).toBe("clean");
    expect(calls).toHaveLength(0);
  });

  it("cleans up and carries on when the re-exec itself fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "argus-ho-fail-"));
    const r = moveSecretsOutOfExecEnv({
      env: { ARGUS_WALLET_KEY: "k" },
      execve: (() => { throw new Error("ENOSYS"); }) as never,
      platform: "linux", tmp,
    });
    expect(r.state).toBe("skipped");
    expect(readdirSync(tmp)).toEqual([]);
  });
});
