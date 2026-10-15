import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeSandbox, planLaunch, resolveMechanism, SandboxRefused, seatbeltProfile,
  type Probe, type SandboxContext, type SandboxedServerRef,
} from "../src/mcp/sandbox.js";

/**
 * WARDEN vets what a server SAYS; a stdio server is still a program running as ARGUS's
 * user. Unconfined it can read the keystore, the episode memory, argus.config.json, the
 * rest of the home directory, and connect to the Docker socket. These tests pin what each
 * mechanism hides, what it re-exposes, and when ARGUS refuses to start a server at all.
 */

const HOME = "/home/u";
const STATE = "/home/u/.argus";

function probe(over: Partial<Probe> = {}): Partial<Probe> {
  return {
    bwrap: () => true,
    sandboxExec: () => true,
    docker: () => true,
    which: (cmd) => (cmd === "npx" ? "/home/u/.nvm/versions/node/v22/bin/npx" : cmd === "node" ? "/home/u/.nvm/versions/node/v22/bin/node" : undefined),
    realpath: (p) => (p.endsWith("/bin/npx") ? "/home/u/.nvm/versions/node/v22/lib/node_modules/npm/bin/npx-cli.js" : p),
    exists: (p) => [HOME, STATE, "/app/argus.config.json", "/run/user/1000", "/run/docker.sock", "/var/run/docker.sock"].includes(p),
    uid: () => 1000,
    gid: () => 1000,
    ...over,
  };
}

function ctx(over: Partial<SandboxContext> = {}): SandboxContext {
  return {
    stateDir: STATE,
    configPath: "/app/argus.config.json",
    production: false,
    platform: "linux",
    home: HOME,
    probe: probe(),
    mkdir: () => {},
    ...over,
  };
}

const npx: SandboxedServerRef = { id: "fs", name: "fs", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/p"] };
const env = { PATH: "/home/u/.nvm/versions/node/v22/bin:/usr/bin", HOME, LANG: "C" };

describe("which mechanism", () => {
  it("auto picks bubblewrap on Linux and Seatbelt on macOS", () => {
    expect(resolveMechanism(npx, ctx()).mechanism).toBe("bwrap");
    expect(resolveMechanism(npx, ctx({ platform: "darwin" })).mechanism).toBe("sandbox-exec");
  });

  it("auto with nothing available runs unconfined on a laptop, loudly", () => {
    const r = resolveMechanism(npx, ctx({ probe: probe({ bwrap: () => false }) }));
    expect(r.mechanism).toBe("none");
    expect(r.warning).toMatch(/UNSANDBOXED/);
  });

  it("auto with nothing available REFUSES on an unattended host", () => {
    expect(() => resolveMechanism(npx, ctx({ production: true, probe: probe({ bwrap: () => false }) }))).toThrow(SandboxRefused);
    expect(() => planLaunch(npx, env, ctx({ production: true, probe: probe({ bwrap: () => false }) }))).toThrow(/AIFACTORY_PROD=1/);
  });

  it("an explicit 'none' is the operator's decision, even in production", () => {
    const r = resolveMechanism({ ...npx, sandbox: { mode: "none" } }, ctx({ production: true, probe: probe({ bwrap: () => false }) }));
    expect(r.mechanism).toBe("none");
    expect(r.explicit).toBe(true);
  });

  it("a requested mechanism that is unavailable refuses instead of downgrading", () => {
    expect(() => resolveMechanism({ ...npx, sandbox: { mode: "bwrap" } }, ctx({ probe: probe({ bwrap: () => false }) }))).toThrow(SandboxRefused);
    expect(() => resolveMechanism({ ...npx, sandbox: { mode: "sandbox-exec" } }, ctx())).toThrow(/only on macOS/);
    expect(() => resolveMechanism({ ...npx, sandbox: { mode: "docker" } }, ctx({ probe: probe({ docker: () => false }) }))).toThrow(/Docker/);
    expect(() => resolveMechanism({ ...npx, sandbox: { mode: "jail" as never } }, ctx())).toThrow(/unknown sandbox mode/);
  });

  it("the server setting wins over the default", () => {
    expect(resolveMechanism({ ...npx, sandbox: { mode: "docker" } }, ctx({ settings: { mode: "bwrap" } })).mechanism).toBe("docker");
    expect(resolveMechanism(npx, ctx({ settings: { mode: "docker" } })).mechanism).toBe("docker");
  });

  it("refuses relative grant paths", () => {
    expect(() => planLaunch({ ...npx, sandbox: { read: ["./project"] } }, env, ctx())).toThrow(/absolute/);
  });
});

describe("bubblewrap plan", () => {
  const plan = planLaunch({ ...npx, sandbox: { read: ["/srv/p"], write: ["~/work"] } }, env, ctx());
  const a = plan.args;
  const at = (flag: string, value: string) => a.findIndex((x, i) => x === flag && a[i + 1] === value);

  it("isolates namespaces and keeps the network unless told otherwise", () => {
    expect(plan.command).toBe("bwrap");
    expect(a).toContain("--unshare-all");
    expect(a).toContain("--share-net");
    expect(a).toContain("--die-with-parent");
    expect(at("--proc", "/proc")).toBeGreaterThan(-1); // a fresh /proc: the parent's environ is not there
    const off = planLaunch({ ...npx, sandbox: { network: false } }, env, ctx());
    expect(off.args).not.toContain("--share-net");
  });

  it("hides home, state and config, then re-exposes only what was granted", () => {
    const root = at("--ro-bind", "/");
    const home = at("--tmpfs", HOME);
    expect(root).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(root);
    expect(at("--tmpfs", STATE)).toBe(-1); // already under the hidden home
    expect(a.slice(at("--ro-bind", "/dev/null"))).toContain("/app/argus.config.json");
    // Granted paths are mounted AFTER the hiding mounts, or they would be hidden too.
    expect(a.indexOf("/srv/p")).toBeGreaterThan(home);
    expect(a.indexOf("/home/u/work")).toBeGreaterThan(home);
    // nvm's node lives in the hidden home: its install prefix comes back read-only.
    expect(at("--ro-bind-try", "/home/u/.nvm/versions/node/v22")).toBeGreaterThan(home);
  });

  it("masks the user's runtime sockets and the Docker socket once each", () => {
    expect(at("--tmpfs", "/run/user/1000")).toBeGreaterThan(-1);
    const masked = a.filter((x, i) => a[i - 1] === "/dev/null" && x.endsWith("docker.sock"));
    expect(masked.length).toBeGreaterThan(0);
    expect(new Set(masked).size).toBe(masked.length);
  });

  it("runs in the server's own home with ARGUS's secrets nowhere in its environment", () => {
    expect(plan.cwd).toMatch(/^\/home\/u\/\.argus\/sandbox\/fs-[0-9a-f]{8}\/home$/);
    expect(plan.env.HOME).toBe(plan.cwd);
    expect(a.slice(a.indexOf("--") + 1)).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/p"]);
    expect(Object.keys(plan.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
  });
});

describe("Seatbelt profile", () => {
  const profile = seatbeltProfile({
    hidden: [HOME], hiddenFiles: ["/app/argus.config.json"], exposed: ["/home/u/.nvm/versions/node/v22"],
    read: ["/srv/p"], write: ["/srv/out"], serverHome: "/home/u/.argus/sandbox/fs/home", network: false,
  });
  const lines = profile.split("\n");
  const idx = (s: string) => lines.findIndex((l) => l.includes(s));

  it("denies writes everywhere and the home directory entirely, before any allow", () => {
    expect(idx('(deny file-write* (subpath "/"))')).toBeLessThan(idx("(allow file-read* (subpath"));
    expect(idx(`(deny file-read* file-write* (subpath "${HOME}"))`)).toBeLessThan(idx('(allow file-read* (subpath "/home/u/.nvm'));
    expect(profile).toContain('(deny file-read* file-write* (literal "/app/argus.config.json"))');
    expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${HOME}")))`);
    expect(profile).toContain("(deny network-outbound (remote ip))");
  });

  it("lets realpath() stat the ancestors of granted paths, and nothing more", () => {
    expect(profile).toContain('(allow file-read-metadata (literal "/home/u"))');
    expect(profile).toContain('(allow file-read-metadata (literal "/home/u/.argus/sandbox"))');
    expect(profile).not.toContain('(allow file-read* (subpath "/home/u"))');
  });

  it("escapes paths so a config value cannot end the string", () => {
    const p = seatbeltProfile({ hidden: ['/h/x") (allow default'], hiddenFiles: [], exposed: [], read: [], write: [], serverHome: "/s", network: true });
    expect(p).toContain('(subpath "/h/x\\") (allow default")');
  });
});

describe("docker plan", () => {
  const plan = planLaunch({ ...npx, env: { GITHUB_TOKEN: "ghp_x" }, sandbox: { mode: "docker", network: false, read: ["/srv/p"] } }, { ...env, GITHUB_TOKEN: "ghp_x" }, ctx());

  it("contains the server and passes secret values only through the environment", () => {
    expect(plan.command).toBe("docker");
    expect(plan.args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000"]));
    expect(plan.args[plan.args.indexOf("--network") + 1]).toBe("none");
    expect(plan.args).toContain("/srv/p:/srv/p:ro");
    expect(plan.args.join(" ")).not.toContain("ghp_x");
    expect(plan.args).toContain("GITHUB_TOKEN");
    expect(plan.env.GITHUB_TOKEN).toBe("ghp_x");
    expect(plan.args.slice(-4)).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/p"]);
  });
});

describe("doctor line", () => {
  it("reports each stdio server and never throws", () => {
    const lines = describeSandbox(
      [npx, { id: "web", name: "web", transport: "http", url: "https://x" }, { ...npx, id: "bad", sandbox: { mode: "bwrap" } }],
      ctx({ probe: probe({ bwrap: () => false }) }),
    );
    expect(lines[0]).toMatch(/^fs: none \(auto\) — UNSANDBOXED/);
    expect(lines[1]).toMatch(/^bad: REFUSED/);
  });
});

// The real thing, where the platform has it. A sandboxed node is asked to read a planted
// keystore, the config and a granted file, and to write outside its home.
describe.runIf(process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0)(
  "sandbox-exec, live",
  () => {
    it("hides state and config, allows only the grants", () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "argus-sbx-")));
      const home = join(root, "home");
      mkdirSync(join(home, ".argus"), { recursive: true });
      mkdirSync(join(root, "project"));
      writeFileSync(join(home, ".argus", "keystore.json"), "KEYSTORE");
      writeFileSync(join(root, "argus.config.json"), "CFG");
      writeFileSync(join(root, "project", "readme"), "OK");
      const code = `
        const fs = require("fs"); const r = {};
        const t = (k, f) => { try { f(); r[k] = "allowed"; } catch (e) { r[k] = "denied"; } };
        t("keystore", () => fs.readFileSync(${JSON.stringify(join(home, ".argus", "keystore.json"))}));
        t("config", () => fs.readFileSync(${JSON.stringify(join(root, "argus.config.json"))}));
        t("granted", () => fs.readFileSync(${JSON.stringify(join(root, "project", "readme"))}));
        t("writeGranted", () => fs.writeFileSync(${JSON.stringify(join(root, "project", "x"))}, "x"));
        t("writeOutside", () => fs.writeFileSync(${JSON.stringify(join(root, "planted"))}, "x"));
        t("writeHome", () => fs.writeFileSync(process.env.HOME + "/ok", "x"));
        console.log(JSON.stringify(r));`;
      const plan = planLaunch(
        { id: "probe", name: "probe", transport: "stdio", command: process.execPath, args: ["-e", code], sandbox: { read: [join(root, "project")] } },
        { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        { stateDir: join(home, ".argus"), configPath: join(root, "argus.config.json"), production: false, home },
      );
      expect(plan.mechanism).toBe("sandbox-exec");
      const out = spawnSync(plan.command, plan.args, { env: plan.env, cwd: plan.cwd, encoding: "utf8" });
      expect(JSON.parse(out.stdout.trim())).toEqual({
        keystore: "denied", config: "denied", granted: "allowed",
        writeGranted: "denied", writeOutside: "denied", writeHome: "allowed",
      });
    });
  },
);
