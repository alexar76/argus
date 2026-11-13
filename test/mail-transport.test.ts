import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMail } from "../src/mail/index.js";
import { MICROSOFT_MAIL_SCOPES, MICROSOFT_TOKEN_ENDPOINT } from "../src/mail/types.js";

const deps = vi.hoisted(() => {
  const imap = {
    on: vi.fn(), connect: vi.fn(), close: vi.fn(), mailboxOpen: vi.fn(), fetch: vi.fn(), fetchOne: vi.fn(), search: vi.fn(),
  };
  const smtp = { verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() };
  return {
    imap, smtp,
    imapClient: vi.fn(function () { return imap; }),
    smtpClient: vi.fn(() => smtp),
    popClient: vi.fn(),
    pinMailServer: vi.fn(),
  };
});

vi.mock("imapflow", () => ({ ImapFlow: deps.imapClient }));
vi.mock("nodemailer", async (original) => {
  const actual = (await original<typeof import("nodemailer")>()).default;
  return {
    default: {
      createTransport(options: Parameters<typeof actual.createTransport>[0]) {
        return options && "streamTransport" in options ? actual.createTransport(options) : deps.smtpClient(options);
      },
    },
  };
});
vi.mock("node:tls", async (original) => ({ ...await original<typeof import("node:tls")>(), connect: deps.popClient }));
vi.mock("../src/mail/discovery.js", () => ({ pinMailServer: deps.pinMailServer }));

import { defaultMailTransport } from "../src/mail/transport.js";

const account: StoredMail = {
  accountId: "mail-fixture", email: "owner@example.com", username: "owner@example.com", provider: "Example", source: "manual",
  password: "fixture-password", auth: "password", permissions: { read: true, send: true, otp: true },
  incoming: { protocol: "imap", host: "imap.example.com", port: 993 },
  outgoing: { host: "smtp.example.com", port: 587 },
};

const gmailAccount: StoredMail = {
  ...account, email: "owner@gmail.com", username: "owner@gmail.com", auth: "gmail-oauth",
  gmailClient: { clientId: "fixture.apps.googleusercontent.com", clientSecret: "fixture-client-secret" },
  incoming: { protocol: "imap", host: "imap.gmail.com", port: 993 }, outgoing: { transport: "gmail-api" },
};
const gmailProfileUrl = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const gmailSendUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const reply = { to: "booking@example.org", subject: "Re: Booking", text: "My answer", inReplyTo: "<notice@example.org>", gmailThreadId: "11b94d1e5f2a6091" };

const microsoftAccount: StoredMail = {
  ...account, email: "owner@outlook.com", username: "owner@outlook.com", auth: "microsoft-oauth", graph: true,
  microsoftClientId: "a1491dfb-e933-47bb-992b-d8266a6f4eac", password: "fixture-microsoft-refresh",
  incoming: undefined, outgoing: undefined,
};
const graphApi = "https://graph.microsoft.com/v1.0/me";
const graphInbox = `${graphApi}/mailFolders/inbox/messages`;
const graphSender = "booking@example.org";
const graphDate = "2026-11-13T09:00:00.000Z";
const graphRow = {
  id: "fixture+/id=", from: { emailAddress: { address: graphSender } }, subject: "Verify your booking", receivedDateTime: graphDate,
};
const graphBody = {
  ...graphRow, body: { contentType: "text", content: "Verification code: 123456. Reference 12bc4de567f8a90b." },
  internetMessageId: "<notice@example.org>", replyTo: [{ emailAddress: { address: "redirect@example.org" } }],
};

function mockGmail(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ access_token: "fixture-access-token" }));
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function mockMicrosoft(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({
    access_token: "fixture-graph-token", token_type: "Bearer", scope: "Mail.Send Mail.Read User.Read",
  }));
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requestUrl(mock: ReturnType<typeof mockMicrosoft>, index: number): URL {
  return new URL(String(mock.mock.calls[index]?.[0]));
}

const raw = Buffer.from([
  "From: Reservations <booking@example.org>",
  "Reply-To: bookings@example.org",
  "Subject: Verify your booking",
  "Message-ID: <notice@example.org>",
  "Date: Mon, 1 Jan 2001 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Verification code: 123456. Reference 12bc4de567f8a90b.",
  "",
].join("\r\n"));

describe("mail protocol transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.pinMailServer.mockResolvedValue("93.184.216.34");
    deps.imap.mailboxOpen.mockResolvedValue({ uidValidity: 12n, exists: 1 });
    deps.imap.fetchOne.mockResolvedValue({ source: raw, size: raw.length });
    deps.smtp.sendMail.mockResolvedValue({ accepted: ["booking@example.org"], rejected: [] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("pins the IMAP peer while keeping certificate validation and opens the inbox read-only", async () => {
    const result = await defaultMailTransport.read(account, "imap:12:1");
    expect(result).toMatchObject({ id: "imap:12:1", from: "booking@example.org", messageId: "<notice@example.org>", replyTo: "bookings@example.org" });
    expect(result.text).toContain("Reference 12bc4de567f8a90b");
    expect(result).not.toHaveProperty("codeText");
    expect(deps.imapClient).toHaveBeenCalledWith(expect.objectContaining({
      host: "93.184.216.34", servername: "imap.example.com", secure: true, logger: false,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    }));
    expect(deps.imap.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(deps.imap.fetchOne).toHaveBeenCalledWith("1", expect.objectContaining({ size: true }), { uid: true });
    expect(deps.imap.close).toHaveBeenCalledOnce();
    deps.imap.fetchOne.mockClear();
    await expect(defaultMailTransport.read(account, "imap:11:1")).rejects.toThrow("inbox changed");
    expect(deps.imap.fetchOne).not.toHaveBeenCalled();
  });

  it("checks code freshness against the IMAP internal timestamp, independent of the sender's Date header", async () => {
    const arrival = new Date();
    deps.imap.search.mockResolvedValue([1]);
    deps.imap.fetch.mockImplementation(async function* () {
      yield { uid: 1, internalDate: arrival, envelope: { from: [{ address: "booking@example.org" }] }, size: raw.length };
    });
    const matches = await defaultMailTransport.codeCandidates(account, "booking@example.org", arrival.getTime() - 1000);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.receivedAt).toBe(arrival.getTime());
    expect(matches[0]?.date).toBe("2001-01-01T10:00:00.000Z");
    expect(matches[0]?.codeText).toContain("123456");
  });

  it("closes an active IMAP socket when the booking deadline aborts", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    deps.imap.search.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      deps.imap.close.mockImplementationOnce(() => reject(new Error("connection closed")));
      markStarted();
    }));
    const result = defaultMailTransport.codeCandidates(account, "booking@example.org", Date.now() - 1000, controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toThrow("connection closed");
    expect(deps.imap.close).toHaveBeenCalled();
  });

  it("uses stable POP3 UIDs and reads a dot-stuffed response without deleting mail", async () => {
    const wire = [
      "+OK server ready\r\n", "+OK username accepted\r\n+OK password accepted\r\n",
      "+OK listing follows\r\n1 stable-uid\r\n.\r\n+OK message follows\r\n",
      raw.toString("utf8"), "..visible dot\r\n.\r\n+OK goodbye\r\n",
    ];
    const socket = {
      write: vi.fn(), destroy: vi.fn(),
      async *[Symbol.asyncIterator]() { for (const part of wire) yield Buffer.from(part); },
    };
    deps.popClient.mockReturnValue(socket);
    const id = `pop3:${Buffer.from("stable-uid").toString("base64url")}`;
    const result = await defaultMailTransport.read({ ...account, incoming: { protocol: "pop3", host: "pop.example.com", port: 995 } }, id);
    expect(result.text).toContain(".visible dot");
    expect(socket.write.mock.calls.map(row => row[0])).toEqual([
      "USER owner@example.com\r\n", "PASS fixture-password\r\n", "UIDL\r\n", "RETR 1\r\n", "QUIT\r\n",
    ]);
    expect(deps.popClient).toHaveBeenCalledWith(expect.objectContaining({
      host: "93.184.216.34", servername: "pop.example.com", port: 995, rejectUnauthorized: true,
    }));
  });

  it("requires SMTP STARTTLS and submits only the reviewed recipient and body", async () => {
    await defaultMailTransport.send(account, { to: "booking@example.org", subject: "Re: Booking", text: "My answer", inReplyTo: "<notice@example.org>" });
    expect(deps.smtpClient).toHaveBeenCalledWith(expect.objectContaining({
      host: "93.184.216.34", port: 587, secure: false, requireTLS: true, disableFileAccess: true, disableUrlAccess: true,
      tls: expect.objectContaining({ servername: "smtp.example.com", rejectUnauthorized: true }),
    }));
    expect(deps.smtp.sendMail).toHaveBeenCalledWith({
      from: { address: "owner@example.com", name: "" }, to: { address: "booking@example.org", name: "" },
      subject: "Re: Booking", text: "My answer", inReplyTo: "<notice@example.org>", references: "<notice@example.org>",
    });
    expect(deps.smtp.close).toHaveBeenCalledOnce();
  });

  it("verifies the Gmail profile over HTTPS and rejects a different mailbox", async () => {
    const fetch = mockGmail(Response.json({ emailAddress: "Owner@gmail.com" }));
    await expect(defaultMailTransport.verify(gmailAccount)).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([googleTokenUrl, gmailProfileUrl]);
    expect(fetch).toHaveBeenLastCalledWith(gmailProfileUrl, expect.objectContaining({
      method: "GET", headers: { authorization: "Bearer fixture-access-token" }, redirect: "error", signal: expect.any(AbortSignal),
    }));
    expect(deps.smtpClient).not.toHaveBeenCalled();
    const wrongAccount = mockGmail(Response.json({ emailAddress: "different@gmail.com" }));
    await expect(defaultMailTransport.verify(gmailAccount)).rejects.toThrow("does not match the configured mailbox");
    expect(wrongAccount.mock.calls.map(([url]) => url)).toEqual([googleTokenUrl, gmailProfileUrl]);
  });

  it("converts Gmail's IMAP thread ID to hexadecimal without rounding", async () => {
    mockGmail();
    const decimalThread = "18446744073709551615";
    deps.imap.fetchOne.mockResolvedValueOnce({ source: raw, size: raw.length, threadId: decimalThread });
    const result = await defaultMailTransport.read(gmailAccount, "imap:12:1");
    expect(result.gmailThreadId).toBe("ffffffffffffffff");
    expect(deps.imap.fetchOne).toHaveBeenCalledWith("1", expect.objectContaining({ threadId: true }), { uid: true });
  });

  it("sends the exact reviewed MIME and thread through a single Gmail API request", async () => {
    const fetch = mockGmail(Response.json({ id: "sent-message-id" }));
    await defaultMailTransport.send(gmailAccount, reply);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([googleTokenUrl, gmailSendUrl]);
    const request = fetch.mock.calls[1]?.[1];
    expect(request).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-access-token");
    const payload = JSON.parse(String(request?.body)) as { raw: string; threadId: string };
    expect(payload.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload.threadId).toBe(reply.gmailThreadId);
    const message = await simpleParser(Buffer.from(payload.raw, "base64url"));
    expect(message).toMatchObject({ from: { value: [{ address: gmailAccount.email }] }, to: { value: [{ address: reply.to }] },
      subject: reply.subject, inReplyTo: reply.inReplyTo, references: reply.inReplyTo, attachments: [] });
    expect(message.text?.trim()).toBe(reply.text);
    expect(message.cc).toBeUndefined();
    expect(message.bcc).toBeUndefined();
    expect(deps.smtpClient).not.toHaveBeenCalled();
  });

  it.each([403, 200])("does not retry an unconfirmed Gmail send on HTTP %s", async (status) => {
    const fetch = mockGmail(Response.json({}, { status }));
    await expect(defaultMailTransport.send(gmailAccount, reply)).rejects.toThrow("Gmail API did not");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([googleTokenUrl, gmailSendUrl]);
    expect(deps.smtpClient).not.toHaveBeenCalled();
  });

  it("requires OAuth before the Gmail API sends any data", async () => {
    const fetch = mockGmail();
    await expect(defaultMailTransport.send({ ...gmailAccount, auth: "password" }, reply)).rejects.toThrow("requires Gmail OAuth");
    expect(fetch).not.toHaveBeenCalled();
    expect(deps.smtpClient).not.toHaveBeenCalled();
  });

  it("verifies the selected Microsoft mailbox and inbox before connecting", async () => {
    const fetch = mockMicrosoft(Response.json({ mail: "Owner@outlook.com" }), Response.json({ id: "inbox-folder" }));
    await expect(defaultMailTransport.verify(microsoftAccount)).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => String(url).split("?")[0])).toEqual([
      MICROSOFT_TOKEN_ENDPOINT, graphApi, `${graphApi}/mailFolders/inbox`,
    ]);
    const refreshRequest = fetch.mock.calls[0]?.[1];
    expect(refreshRequest).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    expect(Object.fromEntries(new URLSearchParams(String(refreshRequest?.body)))).toEqual({
      client_id: microsoftAccount.microsoftClientId, grant_type: "refresh_token", refresh_token: microsoftAccount.password, scope: MICROSOFT_MAIL_SCOPES,
    });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer fixture-graph-token");
    expect(deps.imapClient).not.toHaveBeenCalled();
    expect(deps.smtpClient).not.toHaveBeenCalled();
    const wrongMailbox = mockMicrosoft(Response.json({ mail: "different@outlook.com", userPrincipalName: microsoftAccount.email }));
    await expect(defaultMailTransport.verify(microsoftAccount)).rejects.toThrow("does not match the configured mailbox");
    expect(wrongMailbox).toHaveBeenCalledTimes(2);
  });

  it("refreshes incoming-only Microsoft access without send and blocks direct transport sends", async () => {
    const incomingOnly = { ...microsoftAccount, graphIncomingOnly: true } as const;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "fixture-graph-token", token_type: "Bearer", scope: "User.Read Mail.Read" }))
      .mockResolvedValueOnce(Response.json({ mail: microsoftAccount.email }))
      .mockResolvedValueOnce(Response.json({ id: "inbox-folder" }));
    vi.stubGlobal("fetch", fetch);
    await expect(defaultMailTransport.verify(incomingOnly)).resolves.toBeUndefined();
    const params = new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as URLSearchParams);
    expect(params.get("scope")?.split(" ")).toEqual([
      "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Read", "offline_access",
    ]);
    await expect(defaultMailTransport.send(incomingOnly, reply)).rejects.toThrow("incoming mail only");
    expect(fetch).toHaveBeenCalledTimes(3);
    const broaderToken = mockMicrosoft();
    await expect(defaultMailTransport.verify(incomingOnly)).rejects.toThrow("granted sending access");
    expect(broaderToken).toHaveBeenCalledOnce();
  });

  it("lists only Graph headers and safely reads the chosen message in plain text", async () => {
    const list = mockMicrosoft(Response.json({ value: [graphRow], "@odata.nextLink": "https://untrusted.example/" }));
    const headers = await defaultMailTransport.list(microsoftAccount, 5);
    expect(headers).toEqual([{ id: `graph:${graphRow.id}`, from: graphSender, subject: graphRow.subject, date: graphDate }]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(requestUrl(list, 1).searchParams.get("$select")).toBe("id,from,subject,receivedDateTime");
    expect(requestUrl(list, 1).searchParams.get("$top")).toBe("5");
    const read = mockMicrosoft(Response.json(graphBody));
    const message = await defaultMailTransport.read(microsoftAccount, headers[0]!.id);
    expect(requestUrl(read, 1).pathname).toBe(`/v1.0/me/mailFolders/inbox/messages/${encodeURIComponent(graphRow.id)}`);
    expect(new Headers(read.mock.calls[1]?.[1]?.headers).get("prefer")).toContain('outlook.body-content-type="text"');
    expect(message).toMatchObject({ from: graphSender, text: graphBody.body.content, messageId: reply.inReplyTo, replyTo: "redirect@example.org" });
    expect(message).not.toHaveProperty("codeText");
  });

  it("fetches bodies only for matching Graph code candidates and rejects additional pages", async () => {
    const recent = Date.parse(graphDate) - 1000;
    const wrong = { ...graphRow, id: "wrong-from", from: { emailAddress: { address: "wrong@example.org" } } };
    const old = { ...graphRow, id: "old", receivedDateTime: "2001-01-01T10:00:00.000Z" };
    const fetch = mockMicrosoft(Response.json({ value: [wrong, old, graphRow] }), Response.json(graphBody));
    const matches = await defaultMailTransport.codeCandidates(microsoftAccount, graphSender, recent);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: `graph:${graphRow.id}`, receivedAt: Date.parse(graphDate), codeText: graphBody.body.content });
    expect(requestUrl(fetch, 1).searchParams.get("$filter")).toBe(`receivedDateTime ge ${new Date(recent).toISOString()} and from/emailAddress/address eq '${graphSender}'`);
    expect(fetch).toHaveBeenCalledTimes(3);
    const nextPage = mockMicrosoft(Response.json({ value: [graphRow], "@odata.nextLink": "https://untrusted.example/" }));
    await expect(defaultMailTransport.codeCandidates(microsoftAccount, graphSender, recent)).rejects.toThrow("Too many Outlook messages");
    expect(nextPage).toHaveBeenCalledTimes(2);
  });

  it("sends exact reviewed MIME through Graph and stops on permission revocation or an unconfirmed response", async () => {
    const accepted = mockMicrosoft(new Response(null, { status: 202 }));
    await defaultMailTransport.send(microsoftAccount, reply);
    expect(String(accepted.mock.calls[1]?.[0])).toBe(`${graphApi}/sendMail`);
    const request = accepted.mock.calls[1]?.[1];
    expect(request).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    expect(new Headers(request?.headers).get("content-type")).toBe("text/plain");
    const parsed = await simpleParser(Buffer.from(String(request?.body), "base64"));
    expect(parsed).toMatchObject({ from: { value: [{ address: microsoftAccount.email }] }, to: { value: [{ address: reply.to }] },
      subject: reply.subject, inReplyTo: reply.inReplyTo, references: reply.inReplyTo, attachments: [] });
    expect(parsed.text?.trim()).toBe(reply.text);
    expect(parsed.cc).toBeUndefined();
    expect(parsed.bcc).toBeUndefined();
    const revoked = mockMicrosoft();
    await expect(defaultMailTransport.send(microsoftAccount, reply, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(revoked).toHaveBeenCalledOnce();
    const uncertain = mockMicrosoft(new Response(null, { status: 200 }));
    await expect(defaultMailTransport.send(microsoftAccount, reply)).rejects.toThrow("did not accept the message");
    expect(uncertain).toHaveBeenCalledTimes(2);
  });
});
