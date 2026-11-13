import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { checkMailOtp, checkMailReply, readTestMessage } from "../src/cli/commands/mail.js";
import { readGoogleDesktopClient } from "../src/cli/commands/mail-oauth.js";
import type { MailCodeRequest, MailSettings } from "../src/mail/index.js";

const sender = "controlled@example.net";
const subject = "ARGUS Gmail live check";
const fixture: MailSettings = {
  accountId: "test-account", email: "owner@example.org", username: "owner@example.org", auth: "gmail-oauth",
  incoming: { protocol: "imap", host: "imap.gmail.com", port: 993 },
  provider: "Gmail", source: "preset", permissions: { read: false, otp: true, send: false },
};

it("imports only the Desktop client pair from an owner-only file", () => {
  const path = mkdtempSync(join(tmpdir(), "argus-gmail-client-"));
  const file = join(path, "client.json");
  const client = { client_id: "test-only.apps.googleusercontent.com", client_secret: "test-only-secret", token_uri: "https://elsewhere.example/token" };
  try {
    writeFileSync(file, JSON.stringify({ installed: client }), { mode: 0o600 });
    expect(readGoogleDesktopClient(file)).toEqual({ clientId: client.client_id, clientSecret: client.client_secret });
    chmodSync(file, 0o644);
    expect(() => readGoogleDesktopClient(file)).toThrow("private Google Desktop app JSON");
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify({ web: client }));
    expect(() => readGoogleDesktopClient(file)).toThrow("Google Desktop app");
  } finally { rmSync(path, { recursive: true, force: true }); }
});

it("requires codes-only permissions and never reports a matching code that differs from the synthetic code", async () => {
  const show = vi.fn();
  const readCode = vi.fn(async (_request: MailCodeRequest) => "721432");
  const mail = { settings: () => fixture, readCode };
  expect(await checkMailOtp(mail, sender, show)).toBe(1);
  const request = readCode.mock.calls[0]![0];
  expect(request).toMatchObject({ sender, accountId: fixture.accountId, subjectIncludes: `ARGUS verification check ${request.reference}` });
  expect(show.mock.calls.flat().join("\n")).not.toContain("721432");
  readCode.mockResolvedValue("314159");
  expect(await checkMailOtp(mail, sender, show)).toBe(0);
  expect(show.mock.lastCall?.[0]).toMatch(/^PASS/);
  readCode.mockClear();
  expect(await checkMailOtp({ ...mail, settings: () => ({ ...fixture, permissions: { ...fixture.permissions, read: true } }) }, sender, show)).toBe(1);
  expect(readCode).not.toHaveBeenCalled();
});

it("reads an exact unique test email and sends only after the owner types SEND for its preview", async () => {
  const entry = { id: "imap:3:27", from: sender, subject, date: "", messageId: "<test-message@example.net>", text: "private test content" };
  const list = vi.fn(async () => [entry]);
  const read = vi.fn(async () => entry);
  const send = vi.fn();
  const mail = { settings: () => ({ ...fixture, permissions: { read: true, otp: false, send: true } }), list, read, send };
  const show = vi.fn();
  const review = vi.fn(async () => "yes");
  expect((await readTestMessage(mail, sender, subject)).message).toBe(entry);
  expect(await checkMailReply(mail, sender, subject, review, show)).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(review.mock.lastCall?.[0]).toContain(`To: ${sender}\nSubject: Re: ${subject}`);
  expect(review.mock.lastCall?.[0]).not.toContain(entry.text);
  review.mockResolvedValue("SEND");
  expect(await checkMailReply(mail, sender, subject, review, show)).toBe(0);
  expect(send).toHaveBeenCalledExactlyOnceWith({ accountId: fixture.accountId, to: sender, subject: `Re: ${subject}`, inReplyTo: entry.messageId,
    text: "ARGUS test reply. The mailbox owner reviewed and confirmed this message." });
  list.mockResolvedValue([entry, entry]);
  await expect(readTestMessage(mail, sender, subject)).rejects.toThrow("exactly one");
});
