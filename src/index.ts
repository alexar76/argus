#!/usr/bin/env node
// First, before any other module is evaluated: keep secrets out of the exec-time
// environment, which every process of this user could otherwise read (see
// secret-handoff.ts). The CLI is imported only afterwards, so a module that reads
// process.env at load time sees the values that were moved back in.
import { moveSecretsOutOfExecEnv } from "./secret-handoff.js";

moveSecretsOutOfExecEnv();
const { main } = await import("./cli.js");

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`argus: ${err?.stack ?? err}`);
    process.exit(1);
  });
