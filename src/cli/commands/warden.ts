import type { ArgusConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { Runtime } from "../../runtime.js";
import type { Args } from "../args.js";
import { printFindings } from "../util.js";

export async function cmdWarden(config: ArgusConfig, args: Args): Promise<number> {
  if (args.rest[0] !== "scan") {
    console.error("Usage: argus warden scan");
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
