import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import { fetchNoRedirect } from "../credential-fetch.js";
import { pinMailServer } from "./discovery.js";
import { microsoftGraphMail } from "./microsoft.js";
import { MAIL_MAX_BYTES, withPop3 } from "./pop3.js";
import { cleanMailText, cleanMessageId, mailAddress, type MailCodeCandidate, type MailMessage, type MailSend, type MailSummary, type StoredMail } from "./types.js";

const SOCKET_TIMEOUT_MS = 12_000;
const SESSION_TIMEOUT_MS = 25_000;
const MAX_CODE_TEXT = 16_384;
const MAX_CODE_MESSAGES = 8;
const GMAIL_ACCOUNT_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MailTransport {
  verify(account: StoredMail): Promise<void>;
  list(account: StoredMail, limit: number): Promise<MailSummary[]>;
  read(account: StoredMail, id: string): Promise<MailMessage>;
  codeCandidates(account: StoredMail, sender: string, notBefore: number, signal?: AbortSignal): Promise<MailCodeCandidate[]>;
  send(account: StoredMail, message: MailSend, authorize?: () => void): Promise<void>;
}

async function gmailAccessToken(account: StoredMail, signal?: AbortSignal): Promise<string | undefined> {
  if (account.auth !== "gmail-oauth") return undefined;
  const { clientId, clientSecret } = account.gmailClient ?? {
    clientId: process.env.ARGUS_GMAIL_CLIENT_ID?.trim(),
    clientSecret: process.env.ARGUS_GMAIL_CLIENT_SECRET?.trim(),
  };
  if (!clientId || !clientSecret) throw new Error("Gmail OAuth client credentials are missing on this host.");
  const timeout = AbortSignal.timeout(SOCKET_TIMEOUT_MS);
  const response = await fetchNoRedirect("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: account.password, grant_type: "refresh_token" }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error("Google declined Gmail OAuth access.");
  const body = await response.json() as { access_token?: string };
  if (typeof body.access_token !== "string" || !body.access_token) throw new Error("Google did not return an access token.");
  return body.access_token;
}

async function withImap<T>(
  account: StoredMail, action: (client: ImapFlow) => Promise<T>, options: { accessToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const endpoint = account.incoming;
  if (endpoint?.protocol !== "imap") throw new Error("IMAP is not configured.");
  const { accessToken, signal } = options;
  signal?.throwIfAborted();
  const [host, token] = await Promise.all([pinMailServer(endpoint.host), accessToken ?? gmailAccessToken(account, signal)]);
  signal?.throwIfAborted();
  const client = new ImapFlow({
    host, port: endpoint.port, servername: endpoint.host, secure: true,
    auth: token ? { user: account.username, accessToken: token } : { user: account.username, pass: account.password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    logger: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: SOCKET_TIMEOUT_MS, greetingTimeout: SOCKET_TIMEOUT_MS, socketTimeout: SOCKET_TIMEOUT_MS,
    maxLineLength: 64 * 1024, maxLiteralSize: MAIL_MAX_BYTES, maxResponseSize: MAIL_MAX_BYTES + 64 * 1024,
  });
  // ImapFlow also rejects the pending command on socket failure. Its error event can arrive first.
  client.on("error", () => {});
  const close = () => client.close();
  signal?.addEventListener("abort", close, { once: true });
  const timer = setTimeout(() => client.close(), SESSION_TIMEOUT_MS);
  try {
    await client.connect();
    signal?.throwIfAborted();
    return await action(client);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", close);
    client.close();
  }
}

async function smtp(account: StoredMail, accessToken?: string) {
  const endpoint = account.outgoing;
  if (!endpoint || endpoint.transport === "gmail-api") throw new Error("SMTP is not configured.");
  const [host, token] = await Promise.all([pinMailServer(endpoint.host), accessToken ?? gmailAccessToken(account)]);
  return nodemailer.createTransport({
    host, port: endpoint.port, servername: endpoint.host, secure: endpoint.port === 465, requireTLS: endpoint.port === 587,
    auth: token ? { type: "OAuth2", user: account.username, accessToken: token } : { user: account.username, pass: account.password },
    tls: { servername: endpoint.host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: SOCKET_TIMEOUT_MS, greetingTimeout: SOCKET_TIMEOUT_MS, socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

function outgoingMessage(account: StoredMail, message: MailSend) {
  return {
    from: { address: account.email, name: "" }, to: { address: message.to, name: "" },
    subject: message.subject, text: message.text, inReplyTo: message.inReplyTo, references: message.inReplyTo,
  };
}

function gmailApi(token: string, endpoint: "profile" | "messages/send", message?: { raw: string; threadId?: string }) {
  return fetchNoRedirect(`${GMAIL_ACCOUNT_API}/${endpoint}`, {
    method: message ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(message ? { "content-type": "application/json" } : {}) },
    body: message ? JSON.stringify(message) : undefined,
    signal: AbortSignal.timeout(SOCKET_TIMEOUT_MS),
  });
}

async function verifyGmailApi(account: StoredMail, token?: string): Promise<void> {
  if (!token) throw new Error("Gmail API sending requires Gmail OAuth.");
  const response = await gmailApi(token, "profile");
  if (!response.ok) throw new Error("Could not verify the Gmail API profile. Enable Gmail API in the Google Cloud project.");
  const profile = await response.json() as { emailAddress?: unknown } | null;
  const actual = typeof profile?.emailAddress === "string" ? mailAddress(profile.emailAddress).toLowerCase() : "";
  if (actual !== account.email.toLowerCase() || actual !== mailAddress(account.username).toLowerCase()) {
    throw new Error("The Gmail OAuth profile does not match the configured mailbox.");
  }
}

async function composeMime(account: StoredMail, message: MailSend): Promise<Buffer> {
  const composer = nodemailer.createTransport({
    streamTransport: true, buffer: true, newline: "windows", disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    const result = await composer.sendMail(outgoingMessage(account, message));
    if (!Buffer.isBuffer(result.message)) throw new Error("Could not build the MIME message.");
    return result.message;
  } finally {
    composer.close();
  }
}

async function sendThroughGmailApi(account: StoredMail, message: MailSend, authorize?: () => void): Promise<void> {
  const token = await gmailAccessToken(account);
  if (!token) throw new Error("Gmail API sending requires Gmail OAuth.");
  const threadId = message.inReplyTo && message.gmailThreadId;
  const raw = (await composeMime(account, message)).toString("base64url");
  authorize?.();
  const response = await gmailApi(token, "messages/send", {
    raw,
    ...(threadId ? { threadId } : {}),
  });
  if (!response.ok) throw new Error("Gmail API did not accept the message.");
  const sent = await response.json() as { id?: unknown } | null;
  if (typeof sent?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sent.id)) {
    throw new Error("Gmail API did not confirm the sent message.");
  }
}

function addressOf(addresses?: AddressObject | Array<{ address?: string }>): string {
  const list = Array.isArray(addresses) ? addresses : addresses?.value;
  try {
    return list?.length === 1 && list[0]?.address ? mailAddress(list[0].address) : "";
  } catch {
    return "";
  }
}

function dateText(value?: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value ?? "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

async function parsedSource(id: string, raw: Buffer, receivedAt?: number): Promise<MailCodeCandidate> {
  if (raw.length > MAIL_MAX_BYTES) throw new Error("This message exceeds the mail size limit.");
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const body = mail.text ?? "";
  const uniqueFrom = mail.headerLines.filter(header => header.key === "from").length === 1;
  return {
    id, from: uniqueFrom ? addressOf(mail.from) : "", subject: cleanMailText(mail.subject ?? "", 500),
    date: dateText(mail.date), text: cleanMailText(body, 12_000), messageId: cleanMessageId(mail.messageId),
    replyTo: addressOf(mail.replyTo) || undefined,
    receivedAt: receivedAt ?? 0,
    codeText: body.length <= MAX_CODE_TEXT && (mail.subject?.length ?? 0) <= 500 ? cleanMailText(body, MAX_CODE_TEXT) : undefined,
  };
}

function displayMessage(candidate: MailCodeCandidate): MailMessage {
  return { id: candidate.id, from: candidate.from, subject: candidate.subject, date: candidate.date,
    text: candidate.text, messageId: candidate.messageId, replyTo: candidate.replyTo };
}

function summary(message: MailMessage): MailSummary {
  return { id: message.id, from: message.from, subject: message.subject, date: message.date };
}

async function imapSource(client: ImapFlow, uid: string, id: string, includeGmailThread = false) {
  const row = await client.fetchOne(uid, {
    source: { start: 0, maxLength: MAIL_MAX_BYTES }, size: true, ...(includeGmailThread ? { threadId: true } : {}),
  }, { uid: true });
  if (!row || !row.source) throw new Error(`Message ${id} is no longer available.`);
  if (typeof row.size !== "number" || row.size > MAIL_MAX_BYTES || row.source.length !== row.size) {
    throw new Error("This message exceeds the mail size limit or arrived incomplete.");
  }
  // Gmail's X-GM-THRID is the decimal form of the API's hexadecimal ID.
  const thread = includeGmailThread && row.threadId && /^\d{1,20}$/.test(row.threadId) ? BigInt(row.threadId) : 0n;
  const gmailThreadId = thread > 0n && thread <= 0xffffffffffffffffn ? thread.toString(16) : undefined;
  return { source: row.source, gmailThreadId };
}

export const defaultMailTransport: MailTransport = {
  async verify(account) {
    if (account.graph) return microsoftGraphMail.verify(account);
    const token = await gmailAccessToken(account);
    if (account.incoming?.protocol === "imap") {
      await withImap(account, async client => { await client.mailboxOpen("INBOX", { readOnly: true }); }, { accessToken: token });
    } else if (account.incoming) {
      await withPop3(account.incoming, account.username, account.password, async session => { await session.ids(); });
    }
    if (account.outgoing?.transport === "gmail-api") {
      await verifyGmailApi(account, token);
    } else if (account.outgoing) {
      const client = await smtp(account, token);
      try { await client.verify(); } finally { client.close(); }
    }
  },

  async list(account, limit) {
    if (account.graph) return microsoftGraphMail.list(account, limit);
    if (account.incoming?.protocol === "pop3") {
      return withPop3(account.incoming, account.username, account.password, async session => {
        const messages: MailSummary[] = [];
        for (const row of (await session.ids()).slice(0, limit)) {
          messages.push(summary(await parsedSource(row.id, await session.source(row.number, true))));
        }
        return messages;
      });
    }
    return withImap(account, async client => {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      if (!box.exists) return [];
      const messages: MailSummary[] = [];
      for await (const row of client.fetch(`${Math.max(1, box.exists - limit + 1)}:*`, { envelope: true, internalDate: true })) {
        messages.push({ id: `imap:${box.uidValidity}:${row.uid}`, from: addressOf(row.envelope?.from),
          subject: cleanMailText(row.envelope?.subject ?? "", 500), date: dateText(row.internalDate ?? row.envelope?.date) });
        if (messages.length >= limit) break;
      }
      return messages.reverse();
    });
  },

  async read(account, id) {
    if (account.graph) return microsoftGraphMail.read(account, id);
    if (account.incoming?.protocol === "pop3") {
      return withPop3(account.incoming, account.username, account.password, async session => {
        const row = (await session.ids()).find(item => item.id === id);
        if (!row) throw new Error("Message is no longer available.");
        return displayMessage(await parsedSource(id, await session.source(row.number, false)));
      });
    }
    return withImap(account, async client => {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      const match = /^imap:([1-9][0-9]{0,19}):([1-9][0-9]{0,9})$/.exec(id);
      if (!match?.[2] || match[1] !== box.uidValidity.toString()) throw new Error("This inbox changed. List messages again.");
      const { source, gmailThreadId } = await imapSource(client, match[2], id, account.outgoing?.transport === "gmail-api");
      return { ...displayMessage(await parsedSource(id, source)), ...(gmailThreadId ? { gmailThreadId } : {}) };
    });
  },

  async codeCandidates(account, sender, notBefore, signal) {
    if (account.graph) return microsoftGraphMail.codeCandidates(account, sender, notBefore, signal);
    return withImap(account, async client => {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      if (!box.exists) return [];
      const uids = await client.search({ from: sender, since: new Date(notBefore - 24 * 60 * 60_000) }, { uid: true });
      if (!uids || uids.length === 0) return [];
      if (uids.length > 100) throw new Error("Too many possible code messages.");
      const matches: Array<{ uid: string; time: number }> = [];
      for await (const row of client.fetch(uids, { envelope: true, internalDate: true, size: true }, { uid: true })) {
        const time = row.internalDate instanceof Date ? row.internalDate.getTime() : NaN;
        if (!Number.isFinite(time) || time < notBefore || addressOf(row.envelope?.from) !== sender) continue;
        if (typeof row.size !== "number" || row.size > MAIL_MAX_BYTES || matches.length >= MAX_CODE_MESSAGES) {
          throw new Error("Code messages exceed the configured inspection limit.");
        }
        matches.push({ uid: String(row.uid), time });
      }
      const candidates: MailCodeCandidate[] = [];
      for (const row of matches) {
        const id = `imap:${box.uidValidity}:${row.uid}`;
        const { source } = await imapSource(client, row.uid, id);
        candidates.push(await parsedSource(id, source, row.time));
      }
      return candidates;
    }, { signal });
  },

  async send(account, message, authorize) {
    if (account.graph) return microsoftGraphMail.send(account, await composeMime(account, message), authorize);
    if (account.outgoing?.transport === "gmail-api") {
      await sendThroughGmailApi(account, message, authorize);
      return;
    }
    const client = await smtp(account);
    try {
      authorize?.();
      const result = await client.sendMail(outgoingMessage(account, message));
      if (result.accepted.length !== 1 || result.rejected.length !== 0) throw new Error("SMTP did not accept the message.");
    } finally {
      client.close();
    }
  },
};
