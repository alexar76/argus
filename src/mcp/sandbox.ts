/**
 * Process isolation for stdio MCP servers.
 *
 * WARDEN decides whether a server may connect; it reads tool definitions, it does not
 * contain a process. A stdio server is a program ARGUS starts as ITS OWN user, so without
 * isolation it can open everything ARGUS can: the keystore and episode memory under
 * ~/.argus, argus.config.json, the rest of the home directory (~/.ssh, cloud credentials),
 * and sockets such as Docker's, which is root on most hosts. The allow-listed environment
 * stops a child from being HANDED a secret; it does not stop it from reading files.
 * (Reading ARGUS's own environment is closed separately, see ../secret-handoff.ts.)
 *
 * Mechanisms, chosen per server (`sandbox.mode`, default from `mcp.sandbox.mode`, default
 * "auto"):
 *   bwrap         Linux, bubblewrap: new user/pid/ipc/uts/cgroup namespaces, the whole
 *                 filesystem read-only, the home directory, ARGUS's state, its config,
 *                 /tmp and the per-user runtime sockets replaced by empty mounts, network
 *                 shared unless `network: false`. The parent's /proc is not visible.
 *   sandbox-exec  macOS Seatbelt profile: the same files and sockets denied, network
 *                 optionally denied. Seatbelt does not hide other processes; the secret
 *                 handoff is what keeps ARGUS's environment out of reach there.
 *   docker        Any host with a Docker daemon: the server runs in its own container
 *                 (read-only root, no capabilities, no new privileges, pid/memory limits),
 *                 seeing only its own home and the paths it was given.
 *   none          ARGUS's own privileges. Only by explicit configuration, or when nothing
 *                 else exists on a laptop (with a warning). On an unattended host
 *                 (AIFACTORY_PROD=1) "auto" with nothing available REFUSES to start the
 *                 server rather than running it unconfined.
 *
 * Every sandboxed server gets its own persistent HOME at <stateDir>/sandbox/<id>/home,
 * which is the only place it may write unless `write` names more. Paths it must read go in
 * `read`. Remote (http/sse) servers are other machines' processes and are not affected.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServerRef } from "../types.js";

export type SandboxMode = "auto" | "bwrap" | "sandbox-exec" | "docker" | "none";
export type Mechanism = Exclude<SandboxMode, "auto">;
const MODES: readonly SandboxMode[] = ["auto", "bwrap", "sandbox-exec", "docker", "none"];

/** Per-server settings, under `mcp.servers[].sandbox`. */
export interface ServerSandbox {
  mode?: SandboxMode;
  /** Outbound network. Default true: `npx -y` and `uvx` download the server at start. */
  network?: boolean;
  /** Absolute paths the server may read (exposed read-only). */
  read?: string[];
  /** Absolute paths the server may read and write. */
  write?: string[];
  /** docker mode only: the image to run the command in. */
  image?: string;
}

/** Defaults for every stdio server, under `mcp.sandbox`. */
export interface SandboxSettings {
  mode?: SandboxMode;
  network?: boolean;
  image?: string;
}

export type SandboxedServerRef = McpServerRef & { sandbox?: ServerSandbox };

export interface SandboxContext {
  settings?: SandboxSettings;
  /** ARGUS state (keystore, pins, sandbox homes). Hidden from every sandboxed server. */
  stateDir: string;
  /** Episode memory, if it lives outside stateDir. Hidden too. */
  memoryDir?: string;
  /** argus.config.json. Hidden. */
  configPath?: string;
  /** AIFACTORY_PROD=1: no silent fallback to unconfined. */
  production: boolean;
  platform?: NodeJS.Platform;
  home?: string;
  probe?: Partial<Probe>;
  mkdir?: (path: string) => void;
}

export interface Probe {
  bwrap(): boolean;
  sandboxExec(): boolean;
  docker(): boolean;
  which(command: string, path: string | undefined): string | undefined;
  realpath(path: string): string;
  exists(path: string): boolean;
  uid(): number | undefined;
  gid(): number | undefined;
}

export interface LaunchPlan {
  mechanism: Mechanism;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** One line for logs and `argus doctor`. */
  note: string;
}

export class SandboxRefused extends Error {
  constructor(public readonly serverId: string, message: string) {
    super(message);
    this.name = "SandboxRefused";
  }
}

export const DEFAULT_DOCKER_IMAGE = "node:22-slim";

// ── host probes (each runs at most once per process) ─────────────────────────────

const cache = new Map<string, boolean>();
function once(key: string, fn: () => boolean): boolean {
  if (!cache.has(key)) {
    let ok = false;
    try { ok = fn(); } catch { ok = false; }
    cache.set(key, ok);
  }
  return cache.get(key)!;
}

function runs(command: string, args: string[]): boolean {
  const r = spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
  return r.status === 0;
}

const defaultProbe: Probe = {
  // Installed is not enough: inside a default Docker container, or under Ubuntu's
  // AppArmor userns restriction, bwrap exists and cannot create a namespace.
  bwrap: () => once("bwrap", () => runs("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"])),
  sandboxExec: () => once("sandbox-exec", () => existsSync("/usr/bin/sandbox-exec") && runs("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"])),
  docker: () => once("docker", () => runs("docker", ["version", "--format", "{{.Server.Version}}"])),
  which: (command, path) => which(command, path),
  realpath: (p) => { try { return realpathSync(p); } catch { return p; } },
  exists: (p) => existsSync(p),
  uid: () => process.getuid?.(),
  gid: () => process.getgid?.(),
};

/** Forget probe results (tests). */
export function resetSandboxProbes(): void {
  cache.clear();
}

function which(command: string, path: string | undefined): string | undefined {
  if (command.includes("/")) return isAbsolute(command) ? command : resolve(command);
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return undefined;
}

// ── resolution ───────────────────────────────────────────────────────────────

function requestedMode(server: SandboxedServerRef, ctx: SandboxContext): SandboxMode {
  const raw = server.sandbox?.mode ?? ctx.settings?.mode ?? "auto";
  if (!MODES.includes(raw)) {
    throw new SandboxRefused(server.id, `server "${server.id}": unknown sandbox mode "${String(raw)}" (use ${MODES.join(" | ")})`);
  }
  return raw;
}

/** Which mechanism a server would run under, or why it cannot run. Pure apart from probes. */
export function resolveMechanism(
  server: SandboxedServerRef,
  ctx: SandboxContext,
): { mechanism: Mechanism; explicit: boolean; warning?: string } {
  const probe = { ...defaultProbe, ...ctx.probe };
  const platform = ctx.platform ?? process.platform;
  const mode = requestedMode(server, ctx);
  const unavailable = (what: string, why: string) =>
    new SandboxRefused(server.id, `server "${server.id}": sandbox mode "${what}" was requested but ${why}. Nothing was started.`);

  switch (mode) {
    case "none":
      return {
        mechanism: "none",
        explicit: true,
        warning: `server "${server.id}" runs UNSANDBOXED by configuration: it can read every file ARGUS can, including its state and config`,
      };
    case "bwrap":
      if (platform !== "linux") throw unavailable(mode, "bubblewrap exists only on Linux");
      if (!probe.bwrap()) throw unavailable(mode, "bubblewrap is missing or cannot create namespaces here (inside a container, or blocked by the kernel)");
      return { mechanism: "bwrap", explicit: true };
    case "sandbox-exec":
      if (platform !== "darwin") throw unavailable(mode, "sandbox-exec exists only on macOS");
      if (!probe.sandboxExec()) throw unavailable(mode, "/usr/bin/sandbox-exec is not usable");
      return { mechanism: "sandbox-exec", explicit: true };
    case "docker":
      if (!probe.docker()) throw unavailable(mode, "no Docker daemon answers");
      return { mechanism: "docker", explicit: true };
    case "auto":
    default:
      if (platform === "linux" && probe.bwrap()) return { mechanism: "bwrap", explicit: false };
      if (platform === "darwin" && probe.sandboxExec()) return { mechanism: "sandbox-exec", explicit: false };
      if (ctx.production) {
        throw new SandboxRefused(
          server.id,
          `server "${server.id}" was not started: no process sandbox is available on this host and AIFACTORY_PROD=1 ` +
            `does not run third-party code unconfined. Install bubblewrap (Linux, outside a container), set ` +
            `"sandbox": {"mode": "docker"} where a Docker daemon is reachable, serve it over http instead, or set ` +
            `"sandbox": {"mode": "none"} on this server to accept that it can read everything ARGUS can.`,
        );
      }
      return {
        mechanism: "none",
        explicit: false,
        warning:
          `server "${server.id}" runs UNSANDBOXED: no sandbox is available on this host` +
          (platform === "linux" ? " (install bubblewrap)" : "") +
          ` — it can read every file ARGUS can. Set "sandbox": {"mode": "none"} to silence this, or "docker" to contain it.`,
      };
  }
}

// ── plans ────────────────────────────────────────────────────────────────────

function safeId(id: string): string {
  const slug = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 48) || "server";
  return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

function expandHomePath(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

function absolutePaths(list: string[] | undefined, home: string, serverId: string, field: string): string[] {
  return (list ?? []).map((raw) => {
    const p = expandHomePath(String(raw), home);
    if (!isAbsolute(p)) {
      throw new SandboxRefused(serverId, `server "${serverId}": sandbox.${field} entries must be absolute paths, got "${raw}"`);
    }
    return resolve(p);
  });
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Directories a command needs that would otherwise be hidden: a node installed by nvm
 * lives in the home directory the sandbox hides. Expose the install prefix (the parent
 * of its bin/), never a hidden root itself and never ~/.local wholesale.
 */
function exposureFor(paths: string[], hidden: string[], home: string): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!hidden.some((h) => within(p, h))) continue;
    const m = /^(.*)\/bin\/[^/]+$/.exec(p);
    const prefix = m?.[1];
    if (prefix && !hidden.includes(prefix) && prefix !== join(home, ".local") && prefix !== home) out.add(prefix);
    else out.add(dirname(p));
  }
  return [...out];
}

interface Common {
  home: string;
  serverHome: string;
  hidden: string[];
  hiddenFiles: string[];
  read: string[];
  write: string[];
  network: boolean;
  exposed: string[];
}

function common(server: SandboxedServerRef, baseEnv: Record<string, string>, ctx: SandboxContext, probe: Probe): Common {
  const home = resolve(ctx.home ?? homedir());
  const stateDir = resolve(expandHomePath(ctx.stateDir, home));
  const serverHome = join(stateDir, "sandbox", safeId(server.id), "home");
  (ctx.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 })))(serverHome);
  const hidden = [home, stateDir];
  if (ctx.memoryDir) hidden.push(resolve(expandHomePath(ctx.memoryDir, home)));
  const hiddenFiles = ctx.configPath ? [resolve(ctx.configPath)] : [];
  const read = absolutePaths(server.sandbox?.read, home, server.id, "read");
  const write = absolutePaths(server.sandbox?.write, home, server.id, "write");
  const network = server.sandbox?.network ?? ctx.settings?.network ?? true;
  const binaries: string[] = [];
  for (const name of [server.command!, "node"]) {
    const found = probe.which(name, baseEnv.PATH);
    if (found) binaries.push(found, probe.realpath(found));
  }
  // Every rule names the path the kernel will see. On macOS /tmp is /private/tmp and a
  // Seatbelt rule written for /tmp/x never matches; a symlinked home or state directory
  // is the same trap on either platform.
  const real = (p: string) => (probe.exists(p) ? probe.realpath(p) : p);
  const realHidden = [...new Set(hidden.flatMap((h) => [h, real(h)]))];
  return {
    home,
    serverHome: real(serverHome),
    hidden: dedupe(realHidden),
    hiddenFiles: [...new Set(hiddenFiles.flatMap((f) => [f, real(f)]))],
    read: read.map(real),
    write: write.map(real),
    network,
    exposed: exposureFor(binaries, realHidden, home).map(real),
  };
}

function dedupe(list: string[]): string[] {
  // A parent already hides its children; keep the outermost of nested entries.
  const sorted = [...new Set(list)].sort((a, b) => a.length - b.length);
  return sorted.filter((p, i) => !sorted.slice(0, i).some((q) => within(p, q)));
}

function bwrapPlan(server: SandboxedServerRef, baseEnv: Record<string, string>, ctx: SandboxContext, probe: Probe): LaunchPlan {
  const c = common(server, baseEnv, ctx, probe);
  const uid = probe.uid();
  const a: string[] = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (c.network) a.push("--share-net");
  a.push("--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  // Hidden after the root bind, re-exposed after that: bwrap applies mounts in order.
  for (const h of c.hidden) if (h !== "/" && probe.exists(h)) a.push("--tmpfs", h);
  for (const f of c.hiddenFiles) if (probe.exists(f)) a.push("--ro-bind", "/dev/null", f);
  // Per-user runtime sockets (ssh-agent, D-Bus, keyrings, rootless docker/podman) and the
  // Docker daemon: a socket on a read-only mount still accepts connect().
  if (uid !== undefined && probe.exists(`/run/user/${uid}`)) a.push("--tmpfs", `/run/user/${uid}`);
  // /var/run is usually a symlink to /run: mask each socket once, at the path it really
  // has, or bwrap fails creating a mount point through the symlink.
  const sockets = new Set<string>();
  for (const s of ["/run/docker.sock", "/var/run/docker.sock", "/run/podman/podman.sock"]) {
    if (probe.exists(s)) sockets.add(probe.realpath(s));
  }
  for (const s of sockets) a.push("--ro-bind", "/dev/null", s);
  for (const p of c.exposed) a.push("--ro-bind-try", p, p);
  for (const p of c.read) a.push("--ro-bind-try", p, p);
  for (const p of c.write) a.push("--bind-try", p, p);
  a.push("--bind", c.serverHome, c.serverHome, "--chdir", c.serverHome);
  a.push("--", server.command!, ...(server.args ?? []));
  return {
    mechanism: "bwrap",
    command: "bwrap",
    args: a,
    env: { ...baseEnv, HOME: c.serverHome, TMPDIR: "/tmp" },
    cwd: c.serverHome,
    note: `bwrap · network ${c.network ? "on" : "off"} · home ${c.serverHome}` + rw(c),
  };
}

/** Seatbelt string literal. Paths come from config and the filesystem, so escape them. */
function sb(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(c: Pick<Common, "hidden" | "hiddenFiles" | "exposed" | "read" | "write" | "serverHome" | "network">, extraHidden: string[] = []): string {
  const lines = ["(version 1)", "(allow default)"];
  // Later rules win in Seatbelt: deny the broad roots first, then re-allow inside them.
  // Writes are denied everywhere first: outside the home directory a user still owns
  // places other programs execute from (/opt/homebrew, /usr/local), and a server that
  // can drop a file there escapes the sandbox the next time anything runs it.
  lines.push('(deny file-write* (subpath "/"))');
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))');
  for (const h of [...c.hidden, ...extraHidden]) {
    lines.push(`(deny file-read* file-write* (subpath ${sb(h)}))`);
    lines.push(`(deny network-outbound (remote unix-socket (subpath ${sb(h)})))`);
  }
  for (const f of c.hiddenFiles) lines.push(`(deny file-read* file-write* (literal ${sb(f)}))`);
  for (const s of ["/var/run/docker.sock", "/private/var/run/docker.sock"]) {
    lines.push(`(deny network-outbound (remote unix-socket (literal ${sb(s)})))`);
  }
  if (!c.network) lines.push("(deny network-outbound (remote ip))", "(deny network-inbound (local ip))");
  for (const p of c.exposed) lines.push(`(allow file-read* (subpath ${sb(p)}))`);
  for (const p of c.read) lines.push(`(allow file-read* (subpath ${sb(p)}))`);
  for (const p of c.write) lines.push(`(allow file-read* file-write* (subpath ${sb(p)}))`);
  lines.push(`(allow file-read* file-write* (subpath ${sb(c.serverHome)}))`);
  // realpath() lstat()s every ancestor of a path it resolves, so a granted path under a
  // hidden directory is unreachable unless its ancestors can be stat()ed. Metadata only:
  // listing or reading those directories stays denied.
  const ancestors = new Set<string>();
  for (const p of [...c.exposed, ...c.read, ...c.write, c.serverHome]) {
    for (let d = dirname(p); d !== "/" && !ancestors.has(d); d = dirname(d)) ancestors.add(d);
  }
  for (const d of ancestors) lines.push(`(allow file-read-metadata (literal ${sb(d)}))`);
  return lines.join("\n");
}

function sandboxExecPlan(server: SandboxedServerRef, baseEnv: Record<string, string>, ctx: SandboxContext, probe: Probe): LaunchPlan {
  const c = common(server, baseEnv, ctx, probe);
  // The per-user temporary directory (/var/folders/...) holds other programs' files.
  const extra: string[] = [];
  const t = probe.realpath(tmpdir());
  if (/^\/(private\/)?var\/folders\//.test(t)) extra.push(t);
  const tmp = join(c.serverHome, ".tmp");
  (ctx.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 })))(tmp);
  return {
    mechanism: "sandbox-exec",
    command: "/usr/bin/sandbox-exec",
    args: ["-p", seatbeltProfile(c, extra), server.command!, ...(server.args ?? [])],
    env: { ...baseEnv, HOME: c.serverHome, TMPDIR: tmp },
    cwd: c.serverHome,
    note: `sandbox-exec · network ${c.network ? "on" : "off"} · home ${c.serverHome}` + rw(c),
  };
}

/** Names the docker CLI itself needs from the operator's environment. Not forwarded inside. */
const DOCKER_CLI_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

function dockerPlan(server: SandboxedServerRef, baseEnv: Record<string, string>, ctx: SandboxContext, probe: Probe): LaunchPlan {
  const c = common(server, baseEnv, ctx, probe);
  const image = server.sandbox?.image ?? ctx.settings?.image ?? DEFAULT_DOCKER_IMAGE;
  const uid = probe.uid();
  const gid = probe.gid();
  const a = [
    "run", "--rm", "-i", "--init",
    "--name", `argus-mcp-${safeId(server.id)}-${randomBytes(3).toString("hex")}`,
    "--network", c.network ? "bridge" : "none",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "--pids-limit", "256", "--memory", "1g",
  ];
  if (uid !== undefined && gid !== undefined) a.push("--user", `${uid}:${gid}`);
  a.push("-v", `${c.serverHome}:/home/mcp`, "-e", "HOME=/home/mcp", "-w", "/home/mcp");
  for (const p of c.read) a.push("-v", `${p}:${p}:ro`);
  for (const p of c.write) a.push("-v", `${p}:${p}`);
  // Values travel in the docker CLI's environment, not on its command line (ps shows argv).
  const inside = Object.keys(server.env ?? {});
  for (const k of ["LANG", "TZ", ...inside]) if (k in baseEnv) a.push("-e", k);
  a.push(image, server.command!, ...(server.args ?? []));
  const cliEnv: Record<string, string> = { ...baseEnv };
  for (const k of DOCKER_CLI_ENV) if (process.env[k]) cliEnv[k] = process.env[k]!;
  return {
    mechanism: "docker",
    command: "docker",
    args: a,
    env: cliEnv,
    note: `docker ${image} · network ${c.network ? "on" : "off"} · home ${c.serverHome}` + rw(c),
  };
}

function rw(c: Common): string {
  return (c.read.length ? ` · read ${c.read.join(", ")}` : "") + (c.write.length ? ` · write ${c.write.join(", ")}` : "");
}

/**
 * How to start a stdio server. `baseEnv` is the already allow-listed environment.
 * Throws SandboxRefused when the server must not be started at all.
 */
export function planLaunch(
  server: SandboxedServerRef,
  baseEnv: Record<string, string>,
  ctx: SandboxContext,
): LaunchPlan & { warning?: string } {
  if (!server.command) throw new SandboxRefused(server.id, `server "${server.id}" missing command for stdio transport`);
  const probe: Probe = { ...defaultProbe, ...ctx.probe };
  const { mechanism, warning } = resolveMechanism(server, ctx);
  switch (mechanism) {
    case "bwrap":
      return bwrapPlan(server, baseEnv, ctx, probe);
    case "sandbox-exec":
      return sandboxExecPlan(server, baseEnv, ctx, probe);
    case "docker":
      return dockerPlan(server, baseEnv, ctx, probe);
    case "none":
    default:
      return {
        mechanism: "none",
        command: server.command,
        args: server.args ?? [],
        env: baseEnv,
        note: "UNSANDBOXED — ARGUS's own file access",
        warning,
      };
  }
}

/** One line per stdio server for `argus doctor`; never throws. */
export function describeSandbox(servers: McpServerRef[], ctx: SandboxContext): string[] {
  const stdio = (servers as SandboxedServerRef[]).filter((s) => s.transport === "stdio");
  if (stdio.length === 0) return ["no stdio servers (remote servers are not sandboxed — they are not our processes)"];
  return stdio.map((s) => {
    try {
      const r = resolveMechanism(s, ctx);
      return `${s.id}: ${r.mechanism}${r.explicit ? "" : " (auto)"}${r.warning ? " — UNSANDBOXED" : ""}`;
    } catch (err) {
      return `${s.id}: REFUSED — ${(err as Error).message}`;
    }
  });
}
