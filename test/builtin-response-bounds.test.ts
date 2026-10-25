import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { buildBuiltinTools, WEB_FETCH_MAX_BYTES } from '../src/tools/builtin.js';
import type { Logger, MemoryStore, ToolContext } from '../src/types.js';

const fixture = vi.hoisted(() => ({ reply: undefined as unknown, deliver: (_response: unknown) => {} }));
vi.mock('node:http', () => ({
  request: (_url: unknown, _options: unknown, handler: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => queueMicrotask(() => { handler(fixture.reply); fixture.deliver(fixture.reply); });
    return request;
  },
}));

const log = { debug: () => {} } as unknown as Logger;
const context = { log, approved: false } as ToolContext;
const tool = () => buildBuiltinTools({ memory: {} as MemoryStore, log }).find(item => item.def.name === 'web_fetch')!;

function response(headers: Record<string, string> = {}) {
  const stream = new PassThrough() as PassThrough & Pick<IncomingMessage, 'statusCode' | 'headers'>;
  stream.statusCode = 200;
  stream.headers = headers;
  return stream;
}

beforeEach(() => { fixture.deliver = () => {}; });
describe('web_fetch response bounds', () => {
  it('closes an oversized chunked response while reading it', async () => {
    const stream = response();
    fixture.reply = stream;
    fixture.deliver = () => {
      stream.write(Buffer.alloc(WEB_FETCH_MAX_BYTES));
      stream.write(Buffer.alloc(1));
    };
    const result = await tool().run({ url: 'http://8.8.8.8/' }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('response exceeds');
    expect(stream.destroyed).toBe(true);
  });

  it('refuses an oversized Content-Length without buffering a body', async () => {
    const stream = response({ 'content-length': String(WEB_FETCH_MAX_BYTES + 1) });
    fixture.reply = stream;
    const result = await tool().run({ url: 'http://8.8.8.8/' }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('response exceeds');
    expect(stream.destroyed).toBe(true);
  });

  it('still returns a bounded successful response', async () => {
    fixture.reply = response();
    fixture.deliver = stream => (stream as PassThrough).end('hello');
    const result = await tool().run({ url: 'http://8.8.8.8/' }, context);
    expect(result).toEqual({ ok: true, content: 'HTTP 200\nhello' });
  });
});
