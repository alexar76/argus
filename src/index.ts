#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`argus: ${err?.stack ?? err}`);
    process.exit(1);
  });
