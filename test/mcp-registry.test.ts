import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP registry launch', () => {
  it('starts the same MCP subcommand as the working Glama launch', () => {
    const registry = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    const glama = JSON.parse(readFileSync(new URL('../glama.json', import.meta.url), 'utf8'));
    const pkg = registry.packages.find((p: { identifier: string }) => p.identifier === '@alexar76/argus3');
    const args = pkg.packageArguments.map((arg: { type: string; value: string }) => {
      expect(arg.type).toBe('positional');
      return arg.value;
    });
    expect(args).toEqual(['mcp']);
    expect(glama.command.slice(2)).toEqual(args);
  });
});
