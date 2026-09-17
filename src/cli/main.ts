import { loadConfig } from "../config.js";
import { loadWorkspaceEnv } from "../env-file.js";
import { createLogger } from "../logger.js";
import { runSetupWizard } from "../setup/wizard.js";
import { parse } from "./args.js";
import { printHelp } from "./help.js";
import { cmdAsk, cmdChat } from "./commands/agent.js";
import { cmdTelegram, cmdServe, cmdMcp, cmdFlex } from "./commands/channels.js";
import { cmdKeystore } from "./commands/keystore.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdWarden } from "./commands/warden.js";
import { cmdEconomy } from "./commands/economy.js";
import { cmdVerify } from "./commands/verify.js";
import { cmdStudio } from "./commands/studio.js";
import { cmdPassport } from "./commands/passport.js";
import { cmdBroker } from "./commands/broker.js";

export async function main(argv: string[]): Promise<number> {
  loadWorkspaceEnv();
  const args = parse(argv);
  if (args.flags.verbose) process.env.ARGUS_LOG_LEVEL = "debug";
  createLogger("argus");
  const { config, path } = loadConfig(typeof args.flags.config === "string" ? args.flags.config : undefined);

  switch (args.cmd) {
    case "setup":
      return runSetupWizard();
    case "keystore":
      return cmdKeystore(config, args);
    case "ask":
      return cmdAsk(config, args);
    case "chat":
      return cmdChat(config, args);
    case "doctor":
      return cmdDoctor(config, path);
    case "warden":
      return cmdWarden(config, args);
    case "economy":
      return cmdEconomy(config, args);
    case "telegram":
      return cmdTelegram(config, args);
    case "serve":
      return cmdServe(config);
    case "mcp":
      return cmdMcp(config);
    case "flex":
      return cmdFlex(config);
    case "verify":
      return cmdVerify(args);
    case "oracle":
    case "studio":
      return cmdStudio(config, args);
    case "passport":
      return cmdPassport(config, args);
    case "broker":
      return cmdBroker(config, args);
    case "help":
    default:
      printHelp();
      return 0;
  }
}
