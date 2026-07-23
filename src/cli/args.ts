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
