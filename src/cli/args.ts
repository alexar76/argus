export interface Args {
  cmd: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

export function parse(argv: string[]): Args {
  const a = argv.slice(2);
  const cmd = a[0] ?? "help";
  const rest: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < a.length; i++) {
    const t = a[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = a[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else rest.push(t);
  }
  return { cmd, rest, flags };
}

/**
 * The command to run. A launch with no arguments at all whose stdin and stdout are both pipes
 * is an MCP client starting the package (the registry's default `npx -y @alexar76/argus3` line,
 * directories and conformance harnesses, many of which drop `packageArguments`): it gets the MCP
 * server instead of help text on its JSON-RPC channel. A person at a terminal still gets the help.
 */
export function launchCommand(args: Args, argv: string[], tty: { stdin?: boolean; stdout?: boolean }): string {
  if (argv.length <= 2 && !tty.stdin && !tty.stdout) return "mcp";
  return args.cmd;
}
