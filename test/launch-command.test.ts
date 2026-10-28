import { describe, expect, it } from 'vitest';
import { launchCommand, parse } from '../src/cli/args.js';

const run = (argv: string[], tty: { stdin?: boolean; stdout?: boolean }) => launchCommand(parse(argv), argv, tty);
const bare = ['node', 'argus'];

describe('launch command', () => {
  it('starts the MCP server when a client launches the package with no arguments over pipes', () => {
    // mcp-conformance (2026-09) and HISTOR saw `npx -y @alexar76/argus3` print the help instead.
    expect(run(bare, {})).toBe('mcp');
    expect(run(bare, { stdin: undefined, stdout: undefined })).toBe('mcp');
  });

  it('keeps the help for a person at a terminal', () => {
    expect(run(bare, { stdin: true, stdout: true })).toBe('help');
    expect(run(bare, { stdin: true })).toBe('help');
    expect(run(bare, { stdout: true })).toBe('help');
  });

  it('never overrides an explicit command or flag', () => {
    expect(run([...bare, 'ask', 'hi'], {})).toBe('ask');
    expect(run([...bare, 'help'], {})).toBe('help');
    expect(run([...bare, '--verbose'], {})).toBe('--verbose');
  });
});
