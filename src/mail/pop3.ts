import { connect, type TLSSocket } from "node:tls";
import type { IncomingMail } from "./types.js";
import { pinMailServer } from "./discovery.js";

export const MAIL_MAX_BYTES = 512 * 1024;
const PROTOCOL_TIMEOUT_MS = 18_000;
const MAX_LINE_BYTES = 16_384;

interface PopUid {
  number: number;
  id: string;
}

class PopSession {
  private pending = Buffer.alloc(0);
  private readonly chunks: AsyncIterator<Buffer>;

  constructor(private readonly socket: TLSSocket) {
    this.chunks = socket[Symbol.asyncIterator]();
  }

  private async line(): Promise<Buffer> {
    for (;;) {
      const boundary = this.pending.indexOf("\r\n");
      if (boundary >= 0 && boundary <= MAX_LINE_BYTES) {
        const line = this.pending.subarray(0, boundary);
        this.pending = this.pending.subarray(boundary + 2);
        return line;
      }
      if (this.pending.length > MAX_LINE_BYTES + 1) throw new Error("POP3 response line is too large.");
      const chunk = await this.chunks.next();
      if (chunk.done) throw new Error("POP3 connection ended unexpectedly.");
      this.pending = Buffer.concat([this.pending, chunk.value]);
    }
  }

  async status(command?: string): Promise<boolean> {
    if (command) this.socket.write(`${command}\r\n`);
    const result = (await this.line()).toString("ascii");
    if (/^\+OK(?: |$)/.test(result)) return true;
    if (/^-ERR(?: |$)/.test(result)) return false;
    throw new Error("POP3 returned an invalid response.");
  }

  private async multiline(command: string, limit: number): Promise<Buffer | undefined> {
    if (!(await this.status(command))) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const line = await this.line();
      if (line.length === 1 && line[0] === 46) return Buffer.concat(chunks, total);
      const content = line[0] === 46 ? line.subarray(1) : line;
      total += content.length + 2;
      if (total > limit) throw new Error("POP3 response exceeds the configured size limit.");
      chunks.push(content, Buffer.from("\r\n"));
    }
  }

  async ids(): Promise<PopUid[]> {
    const raw = await this.multiline("UIDL", 4 * 1024 * 1024);
    if (!raw) throw new Error("This POP3 server does not provide stable UIDL message identifiers.");
    const rows: PopUid[] = [];
    const seen = new Set<string>();
    for (const line of raw.toString("ascii").split("\r\n")) {
      if (!line) continue;
      const match = /^([1-9][0-9]{0,8}) ([!-~]{1,70})$/.exec(line);
      if (!match?.[1] || !match[2]) throw new Error("Invalid POP3 message identifier.");
      const id = `pop3:${Buffer.from(match[2], "ascii").toString("base64url")}`;
      if (seen.has(id)) throw new Error("POP3 returned duplicate message identifiers.");
      seen.add(id);
      rows.push({ id, number: Number(match[1]) });
    }
    return rows.sort((a, b) => b.number - a.number);
  }

  async source(number: number, headersOnly: boolean): Promise<Buffer> {
    const headers = headersOnly ? await this.multiline(`TOP ${number} 0`, 64 * 1024) : undefined;
    const source = headers ?? await this.multiline(`RETR ${number}`, MAIL_MAX_BYTES);
    if (!source) throw new Error("POP3 message is no longer available.");
    return source;
  }
}

export async function withPop3<T>(
  endpoint: IncomingMail, username: string, password: string, action: (session: PopSession) => Promise<T>,
): Promise<T> {
  const host = await pinMailServer(endpoint.host);
  const socket = connect({ host, port: endpoint.port, servername: endpoint.host, rejectUnauthorized: true, minVersion: "TLSv1.2" });
  const timer = setTimeout(() => socket.destroy(new Error("POP3 connection timed out.")), PROTOCOL_TIMEOUT_MS);
  try {
    const session = new PopSession(socket);
    if (!(await session.status()) || !(await session.status(`USER ${username}`)) || !(await session.status(`PASS ${password}`))) {
      throw new Error("POP3 authentication failed.");
    }
    const value = await action(session);
    await session.status("QUIT");
    return value;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
