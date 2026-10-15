import { describe, it, expect, vi } from 'vitest';
import { Warden, ThreatFeed, silentLogger } from '@aimarket/warden';
import type { PinnedServer } from '@aimarket/warden';
import { McpHost, type McpClient } from '../src/mcp/host.js';
const server = { id: 'test', name: 'test', transport: 'stdio' as const, command: 'node' };
const tool = { name: 'add', description: 'Add integers.', inputSchema: {} };
const policy = { blockAtSeverity: 'high' as const, sensitiveToolPatterns: [], allowUnknownServers: false, pinToolDefs: true };
function setup() {
  const pins = new Map<string, PinnedServer>();
  const warden = Warden.create({ threatFeed: new ThreatFeed(), policy,
    store: { getPin: async id => pins.get(id), putPin: async pin => { pins.set(pin.serverId, pin); } } });
  let changed = () => {};
  const client = { connect: vi.fn(), listTools: vi.fn(async () => ({ tools: [tool] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: '3' }] })), close: vi.fn(async () => {}),
    setNotificationHandler: (_schema: unknown, handler: () => void) => { changed = handler; } };
  const factory = vi.fn(async () => client as McpClient);
  const host = new McpHost(warden, policy, silentLogger() as any, factory);
  return { host, warden, client, factory, notify: () => changed() };
}
const ctx = { approved: true } as any;
describe('Warden in the MCP host', () => {
  it('blocks unknown catalogs and dangerous launch commands before any connection', async () => {
    const s = setup();
    await expect(s.host.connect({ ...server, catalog: 'remote' })).rejects.toThrow(/WARDEN/);
    await expect(s.host.connect({ ...server, command: 'sh', args: ['-c', 'rm -rf /'] })).rejects.toThrow(/WARDEN/);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it('blocks changed pinned launch identity before connecting', async () => {
    const s = setup();
    await s.warden.approve(server, [tool]);
    await expect(s.host.connect({ ...server, command: 'different' })).rejects.toThrow(/WARDEN/);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it('allows benign calls, but catches unannounced changes before a child tool executes', async () => {
    const s = setup(); await s.host.connect(server);
    const wrapped = s.host.bridgedTools()[0]!;
    expect((await wrapped.run({}, ctx)).ok).toBe(true);
    s.client.listTools.mockResolvedValue({ tools: [{ ...tool, description: 'Add three integers.' }] });
    expect((await wrapped.run({}, ctx)).ok).toBe(false);
    expect(s.client.callTool).toHaveBeenCalledTimes(1);
    expect(s.host.bridgedTools()).toEqual([]);
  });
  it('quarantines immediately on notification, and cannot revive an old wrapper after reapproval', async () => {
    const s = setup(); await s.host.connect(server);
    const wrapped = s.host.bridgedTools()[0]!;
    const changed = [{ ...tool, description: 'Add three integers.' }];
    s.client.listTools.mockResolvedValue({ tools: changed });
    s.notify();
    expect(s.host.bridgedTools()).toEqual([]);
    await new Promise(r => setTimeout(r, 0));
    expect((await wrapped.run({}, ctx)).ok).toBe(false);
    await s.warden.approve(server, changed);
    expect((await wrapped.run({}, ctx)).ok).toBe(false);
    expect(s.client.callTool).not.toHaveBeenCalled();
    expect((await s.host.bridgedTools()[0]!.run({}, ctx)).ok).toBe(true);
  });
  it('rejects metadata drift, not only descriptions', async () => {
    const s = setup(); await s.host.connect(server);
    const wrapped = s.host.bridgedTools()[0]!;
    s.client.listTools.mockResolvedValue({ tools: [{ ...tool, outputSchema: { type: 'string' } } as any] });
    expect((await wrapped.run({}, ctx)).ok).toBe(false);
    expect(s.client.callTool).not.toHaveBeenCalled();
  });
  it('fails closed on list failure and closes a failed initial connection', async () => {
    const s = setup(); s.client.listTools.mockRejectedValue(new Error('offline'));
    await expect(s.host.connect(server)).rejects.toThrow('offline');
    expect(s.client.close).toHaveBeenCalledTimes(1);
    expect(s.host.bridgedTools()).toEqual([]);
  });
  it('checks all pages and rejects duplicate names rather than hiding shadow tools', async () => {
    const s = setup();
    s.client.listTools.mockResolvedValueOnce({ tools: [tool], nextCursor: 'page2' } as any)
      .mockResolvedValueOnce({ tools: [tool] });
    await expect(s.host.connect(server)).rejects.toThrow(/duplicate/);
    expect(s.client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page2' });
    expect(s.client.close).toHaveBeenCalled();
  });
  it('does not execute stale wrappers after shutdown', async () => {
    const s = setup(); await s.host.connect(server);
    const wrapped = s.host.bridgedTools()[0]!; await s.host.closeAll();
    expect((await wrapped.run({}, ctx)).ok).toBe(false);
    expect(s.client.callTool).not.toHaveBeenCalled();
  });
});

it('does not expose or call a snapshot invalidated by a notification while listing', async () => {
  const s = setup(); await s.host.connect(server);
  const wrapped = s.host.bridgedTools()[0]!;
  let release!: (value: { tools: typeof tool[] }) => void;
  s.client.listTools.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const call = wrapped.run({}, ctx);
  await Promise.resolve();
  s.notify();
  release({ tools: [tool] });
  expect((await call).ok).toBe(false);
  expect(s.client.callTool).not.toHaveBeenCalled();
  expect(s.host.bridgedTools()).toEqual([]);
});
it('withholds a result when definitions change during execution without retrying the call', async () => {
  const s = setup(); await s.host.connect(server);
  s.client.callTool.mockImplementationOnce(async () => {
    s.notify();
    return { content: [{ type: 'text', text: 'already executed' }] };
  });
  const result = await s.host.bridgedTools()[0]!.run({}, ctx);
  expect(result.ok).toBe(false);
  expect(result.content).toContain('execution may already have occurred');
  expect(s.client.callTool).toHaveBeenCalledTimes(1);
});

describe('0.3.3 fixes', () => {
  it('calls a tool whose schema has a fractional number (no canonical hash in the per-call check)', async () => {
    const llm = { name: 'llm', description: 'Complete a prompt.', inputSchema: { type: 'object', properties: { temperature: { type: 'number', default: 0.7 } } } };
    const unpinned = { ...policy, pinToolDefs: false };
    const warden = Warden.create({ threatFeed: new ThreatFeed(), policy: unpinned, store: { getPin: async () => undefined, putPin: async () => {} } });
    const client = { connect: vi.fn(), listTools: vi.fn(async () => ({ tools: [llm] })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })), close: vi.fn(async () => {}), setNotificationHandler: () => {} };
    const host = new McpHost(warden, unpinned, silentLogger() as any, async () => client as unknown as McpClient);
    await host.connect(server);
    expect((await host.bridgedTools()[0]!.run({}, ctx)).ok).toBe(true);
  });

  it('a legacy pin blocks a modern server until review() + approve re-pins it', async () => {
    const titled = { ...tool, title: 'Add', annotations: { readOnlyHint: true } };
    const s = setup();
    s.client.listTools.mockResolvedValue({ tools: [titled] });
    // A 0.3.1 pin: three fields, no toolsHashVersion.
    await s.warden.approve(server, [tool]);
    const legacy = await (s.warden as any).gates.find((g: any) => g.name === 'pinning').store.getPin(server.id);
    delete legacy.toolsHashVersion;
    await expect(s.host.connect(server)).rejects.toThrow(/WARDEN/);
    const reviewer = Warden.create({ threatFeed: new ThreatFeed(), policy, store: { getPin: async () => undefined, putPin: async () => {} } });
    const { tools, verdict } = await s.host.review(server, reviewer);
    expect(verdict.allow).toBe(true);
    expect(tools[0]).toMatchObject({ title: 'Add' });
    await s.warden.approve(server, tools);
    await expect(s.host.connect(server)).resolves.toMatchObject({ allow: true });
  });
});

describe('expandHome', () => {
  it('resolves a leading ~/ for paths read from config', async () => {
    const { expandHome } = await import('../src/memory/store.js');
    const { homedir } = await import('node:os');
    expect(expandHome('~/.argus/memory')).toBe(`${homedir()}/.argus/memory`);
    expect(expandHome('/var/argus')).toBe('/var/argus');
  });
});
