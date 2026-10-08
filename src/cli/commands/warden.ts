import { createInterface } from "node:readline/promises";
import { Warden } from "@aimarket/warden";
import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import type { Args } from "../args.js";
import { printFindings } from "../util.js";

const USAGE = "Usage: argus warden scan | argus warden pins status <server-id> | argus warden pins approve <server-id>";

export async function cmdWarden(config: ArgusConfig, args: Args): Promise<number> {
  if (args.rest[0] === "pins") return cmdPins(config, args.rest[1], args.rest[2]);
  if (args.rest[0] !== "scan") {
    console.error(USAGE);
    return 2;
  }
  const log = createLogger("argus", "error");
  const rt = await Runtime.create(config, log);
  const servers = config.mcp.servers;
  if (!servers.length) {
    console.log("No MCP servers configured. Add them under mcp.servers in argus.config.json.");
    return 0;
  }
  console.log(`WARDEN scanning ${servers.length} server(s)…\n`);
  for (const s of servers) {
    try {
      const v = await rt.host.connect(s);
      console.log(`✓ ${s.name}  score ${v.score.toFixed(2)}  allow ${v.allowedTools.length}/${v.allowedTools.length + v.blockedTools.length} tools`);
      printFindings(v.findings);
    } catch (err: any) {
      const v = err?.verdict;
      if (v) {
        console.log(`✕ ${s.name}  BLOCKED by ${v.decidedBy}  score ${v.score.toFixed(2)}`);
        printFindings(v.findings);
      } else {
        console.log(`! ${s.name}  unreachable: ${err.message}`);
      }
    }
  }
  await rt.dispose();
  return 0;
}

/**
 * Review and re-approve a server's pinned tool definitions. The way out of
 * PIN_FORMAT_UPGRADE_REQUIRED (a pin taken before 0.3.2 covered only name, description and
 * inputSchema) and of a genuine TOOL_DEF_DRIFT the operator has looked at. Approval needs a human
 * at a terminal typing the confirmation, and every other gate must still pass.
 */
async function cmdPins(config: ArgusConfig, action: string | undefined, id: string | undefined): Promise<number> {
  if ((action !== "status" && action !== "approve") || !id) {
    console.error(USAGE);
    return 2;
  }
  const server = config.mcp.servers.find((s) => s.id === id);
  if (!server) {
    console.error(`No MCP server with id "${id}" in mcp.servers.`);
    return 2;
  }
  if (action === "approve" && !process.stdin.isTTY) {
    console.error("pins approve needs a human at a terminal (TTY on stdin); refusing non-interactive approval.");
    return 2;
  }
  const rt = await Runtime.create(config, createLogger("argus", "error"));
  try {
    const pin = await rt.memory.getPin(id);
    const reviewer = Warden.create({ policy: config.warden, threatFeed: rt.threatFeed,
      store: { getPin: async () => undefined, putPin: async () => {} } });
    const { tools, verdict } = await rt.host.review(server, reviewer);
    const pinned = await rt.warden.vet(server, tools);
    console.log(`Server ${server.id} (${server.name})`);
    console.log(pin
      ? `  pinned ${pin.approvedAt}, format ${pin.toolsHashVersion === 2 ? "v2 (all advertised fields)" : "legacy (name, description, inputSchema only)"}, tools: ${pin.toolNames.join(", ")}`
      : "  no pin yet");
    console.log(`  now advertising ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
    const pinFindings = pinned.findings.filter((f) => f.gate === "pinning").map((f) => f.code);
    console.log(`  against the pin: ${pinFindings.length ? pinFindings.join(", ") : "matches"}`);
    console.log(`  other gates: ${verdict.allow ? "allow" : "BLOCK"} (score ${verdict.score.toFixed(2)})`);
    printFindings(verdict.findings);
    if (action === "status") return 0;
    if (!verdict.allow) {
      console.error("Approval refused: the server fails a gate other than pinning.");
      return 1;
    }
    console.log("\nCurrent definitions, as they will be pinned:");
    for (const t of tools) console.log(JSON.stringify(t, null, 2));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try { answer = await rl.question(`Type "approve ${id}" to pin these definitions: `); }
    finally { rl.close(); }
    if (answer.trim() !== `approve ${id}`) {
      console.error("Not confirmed; pin unchanged.");
      return 1;
    }
    await rt.warden.approve(server, tools);
    console.log(`approved: ${id}`);
    return 0;
  } catch (err: any) {
    const v = err?.verdict;
    if (v) {
      console.error(`Launch refused by ${v.decidedBy}: ${v.findings.map((f: any) => f.code).join(", ")}`);
      printFindings(v.findings);
    } else {
      console.error(`Review failed: ${err?.message ?? err}`);
    }
    return 1;
  } finally {
    await rt.dispose();
  }
}
