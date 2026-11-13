import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken, resolveTelegramToken, telegramTokenPath } from "../src/economy/keystore.js";
import { canReadMail, canReadMailCode, canSendMail, discoverMail, MailService, type MailCodeCandidate, type MailConnection, type MailTransport } from "../src/mail/index.js";

const account: MailConnection = {
  email: "owner@gmail.com", provider: "Gmail", source: "preset", password: "example-app-password",
  incoming: { protocol: "imap", host: "imap.gmail.com", port: 993 },
  outgoing: { host: "smtp.gmail.com", port: 465 },
};
const sender = "booking@example.com";
const reference = "f9b8ea4327e311b6";
const messageId = "imap:1:8";
const message: MailCodeCandidate = {
  id: messageId, from: sender, subject: "Verify your booking", date: "", text: "private body", receivedAt: 0,
  codeText: `Your verification code: 123456\nReference ${reference}`,
};

describe("ARGUS mail account", () => {
  let stateDir: string;
  let transport: ReturnType<typeof fixture>;
  let mail: MailService;

  function fixture() {
    return {
      verify: vi.fn<MailTransport["verify"]>().mockResolvedValue(undefined),
      list: vi.fn<MailTransport["list"]>().mockResolvedValue([message]),
      read: vi.fn<MailTransport["read"]>().mockResolvedValue(message),
      codeCandidates: vi.fn<MailTransport["codeCandidates"]>().mockResolvedValue([]),
      send: vi.fn<MailTransport["send"]>().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "argus-mail-test-"));
    transport = fixture();
    mail = new MailService(stateDir, "test passphrase", transport);
  });

  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("discovers Gmail by address without a password and rejects a URL disguised as a domain", async () => {
    const setup = await discoverMail("Owner@GMAIL.com");
    expect(setup).toMatchObject({ email: "Owner@gmail.com", source: "preset", incoming: account.incoming, outgoing: account.outgoing });
    await expect(discoverMail("owner@gmail.com/path")).rejects.toThrow();
  });

  it("starts with separate permissions disabled and stores the whole account privately encrypted", async () => {
    const settings = await mail.connect(account);
    const file = join(stateDir, "mail-account.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const contents = readFileSync(file, "utf8");
    expect(contents).not.toContain(account.password);
    expect(contents).not.toContain(account.email);
    expect(settings).not.toHaveProperty("password");
    expect(settings.permissions).toEqual({ read: false, otp: false, send: false });
    settings.permissions.read = true;
    expect(() => new MailService(stateDir, "wrong passphrase").settings()).toThrow("Unable to unlock");
    await expect(mail.list()).rejects.toThrow("Mail read permission is disabled");
    await expect(mail.readCode({ sender, reference, notBefore: Date.now() })).rejects.toThrow("Mail otp permission is disabled");
    await expect(mail.send({ to: sender, subject: "Hello", text: "text" })).rejects.toThrow("Mail send permission is disabled");
    expect(transport.list).not.toHaveBeenCalled();
    expect(transport.codeCandidates).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    chmodSync(file, 0o644);
    expect(() => mail.settings()).toThrow("private regular file");
  });

  it("keeps current and legacy mailbox credentials out of the Telegram token resolver", async () => {
    const passphrase = "test passphrase";
    const gmailClient = { clientId: "test-mail-client.apps.googleusercontent.com", clientSecret: "test-mail-client-secret" };
    const refreshToken = "test-mail-refresh-token";
    const settings = await mail.connect({ ...account, password: refreshToken, auth: "gmail-oauth", gmailClient });
    const current = readFileSync(join(stateDir, "mail-account.json"), "utf8");
    const legacy = encryptToken("argus-mail:v1:" + JSON.stringify({ ...settings, password: refreshToken, gmailClient }), passphrase);
    const path = telegramTokenPath(stateDir);
    const telegramToken = `12345:${"A".repeat(35)}`;

    expect(settings).not.toHaveProperty("gmailClient");
    expect(current).not.toContain(refreshToken);
    expect(current).not.toContain(gmailClient.clientSecret);
    expect(() => decryptToken(JSON.parse(current), passphrase)).toThrow();
    vi.stubEnv("ARGUS_KEYSTORE_PASSPHRASE", passphrase);
    try {
      writeFileSync(path, current, { mode: 0o600 });
      expect(resolveTelegramToken(stateDir)).toBeUndefined();
      writeFileSync(path, JSON.stringify(legacy), { mode: 0o600 });
      expect(resolveTelegramToken(stateDir)).toBeUndefined();
      writeFileSync(path, JSON.stringify(encryptToken(telegramToken, passphrase)), { mode: 0o600 });
      expect(resolveTelegramToken(stateDir)).toBe(telegramToken);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it("persists Microsoft Graph separately and only enables the requested grant", async () => {
    const graph: MailConnection = {
      email: "owner@outlook.com", provider: "Outlook.com", source: "preset", graph: true, auth: "microsoft-oauth",
      password: "fixture-microsoft-refresh", microsoftClientId: "a1491dfb-e933-47bb-992b-d8266a6f4eac",
    };
    await expect(mail.connect({ ...graph, auth: "password" })).rejects.toThrow("requires Microsoft OAuth");
    await expect(mail.connect({ ...graph, incoming: account.incoming })).rejects.toThrow("no separate mail servers");
    await expect(mail.connect({ ...graph, microsoftClientId: "invalid" })).rejects.toThrow("UUID format");
    const settings = await mail.connect(graph);
    const persisted = readFileSync(join(stateDir, "mail-account.json"), "utf8");
    expect(persisted).not.toContain(graph.password);
    expect(persisted).not.toContain(graph.microsoftClientId!);
    expect(settings).not.toHaveProperty("microsoftClientId");
    expect(settings).not.toHaveProperty("password");
    expect([canReadMail(settings), canReadMailCode(settings), canSendMail(settings)]).toEqual([true, true, true]);
    const restarted = new MailService(stateDir, "test passphrase", transport);
    expect(restarted.settings()).toEqual(settings);
    expect(restarted.setPermissions({ otp: true }).permissions).toEqual({ read: false, otp: true, send: false });
    await expect(restarted.list()).rejects.toThrow("Mail read permission is disabled");
    await expect(restarted.send({ to: sender, subject: "Hello", text: "text" })).rejects.toThrow("Mail send permission is disabled");
    transport.codeCandidates.mockResolvedValue([{ ...message, receivedAt: Date.now() }]);
    await expect(restarted.readCode({ sender, reference, notBefore: Date.now() - 5000 })).resolves.toBe("123456");
    expect(transport.codeCandidates.mock.calls[0]?.[0]).toMatchObject({ graph: true, microsoftClientId: graph.microsoftClientId });
    restarted.setPermissions({ read: true });
    await expect(restarted.read("imap:1:2")).rejects.toThrow("Select an inbox message first");
  }, 15_000);

  it("preserves the incoming-only Microsoft capability across restarts and blocks enabling send", async () => {
    const settings = await mail.connect({
      email: "owner@outlook.com", provider: "Outlook.com", source: "preset", graph: true, graphIncomingOnly: true,
      auth: "microsoft-oauth", password: "fixture-microsoft-refresh", microsoftClientId: "a1491dfb-e933-47bb-992b-d8266a6f4eac",
    });
    const restarted = new MailService(stateDir, "test passphrase", transport);
    expect(restarted.settings()).toEqual(settings);
    expect([canReadMail(settings), canReadMailCode(settings), canSendMail(settings)]).toEqual([true, true, false]);
    expect(() => restarted.setPermissions({ send: true })).toThrow("Configure outgoing mail");
    expect(restarted.setPermissions({ otp: true }).permissions).toEqual({ read: false, otp: true, send: false });
    transport.codeCandidates.mockResolvedValue([{ ...message, receivedAt: Date.now() }]);
    await expect(restarted.readCode({ sender, reference, notBefore: Date.now() - 5000 })).resolves.toBe("123456");
    expect(transport.codeCandidates.mock.calls[0]?.[0]).toMatchObject({ graphIncomingOnly: true });
  }, 15_000);

  it("reads a legacy mail vault and rewrites it for the mail purpose on update", () => {
    const passphrase = "test passphrase";
    const file = join(stateDir, "mail-account.json");
    const writeVault = (plaintext: string) => writeFileSync(file, JSON.stringify(encryptToken(plaintext, passphrase)), { mode: 0o600 });
    const telegramToken = `12345:${"A".repeat(35)}`;
    writeVault(telegramToken);
    expect(() => mail.settings()).toThrow("Unable to unlock");

    const accountId = "00000000-0000-4000-8000-000000000001";
    writeVault("argus-mail:v1:" + JSON.stringify({ ...account, accountId }));
    expect(mail.settings()).toMatchObject({ accountId, email: account.email });
    expect(mail.setPermissions({ read: true }).permissions).toEqual({ read: true, otp: false, send: false });
    const updated = JSON.parse(readFileSync(file, "utf8"));
    expect(() => decryptToken(updated, passphrase)).toThrow();
    expect(decryptToken(updated, passphrase, "mail-account")).toMatch(/^argus-mail:v1:/);
  }, 15_000);

  it("reads only a fresh unambiguous code matching sender and the whole request reference", async () => {
    const settings = await mail.connect(account);
    mail.setPermissions({ otp: true });
    const receivedAt = Date.now();
    const request = { sender, reference, subjectIncludes: "Verify your booking", notBefore: receivedAt - 2000, accountId: settings.accountId };
    transport.codeCandidates.mockResolvedValue([
      { ...message, receivedAt: receivedAt - 5000, codeText: `OTP 654321, ${reference}` },
      { ...message, receivedAt, from: "other@example.com", codeText: `OTP 654321, ${reference}` },
      { ...message, receivedAt, codeText: `OTP 654321, prefixed-${reference}` },
      { ...message, receivedAt, subject: "A different request", codeText: `OTP 654321, ${reference}` },
      { ...message, receivedAt },
    ]);
    await expect(mail.readCode(request)).resolves.toBe("123456");
    await expect(mail.list()).rejects.toThrow("Mail read permission is disabled");
    transport.codeCandidates.mockResolvedValue([{ ...message, receivedAt, codeText: `OTP 111111 and OTP 222222, ${reference}` }]);
    await expect(mail.readCode(request)).resolves.toBeNull();
    await expect(mail.readCode({ ...request, reference: "123456" })).rejects.toThrow("Invalid code request scope");
  });

  it("accepts IMAP's second-precision timestamp for a matching challenge requested during that second", async () => {
    await mail.connect({ ...account, permissions: { otp: true, read: false, send: false } });
    const receivedAt = Math.floor(Date.now() / 1000) * 1000 - 1000;
    transport.codeCandidates.mockResolvedValue([{ ...message, receivedAt }]);
    await expect(mail.readCode({ sender, reference, notBefore: receivedAt + 731 })).resolves.toBe("123456");
    transport.codeCandidates.mockResolvedValue([{ ...message, receivedAt: receivedAt - 1000 }]);
    await expect(mail.readCode({ sender, reference, notBefore: receivedAt + 731 })).resolves.toBeNull();
  });

  it("discards a code if access was revoked while checking the inbox", async () => {
    await mail.connect({ ...account, permissions: { otp: true, read: false, send: false } });
    let complete!: (rows: MailCodeCandidate[]) => void;
    transport.codeCandidates.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const result = mail.readCode({ sender, reference, notBefore: Date.now() - 1000 });
    new MailService(stateDir, "test passphrase", transport).setPermissions({ otp: false });
    complete([{ ...message, receivedAt: Date.now() }]);
    await expect(result).rejects.toThrow("Mail otp permission is disabled");
  });

  it("returns when the booking deadline aborts an in-flight mail read", async () => {
    await mail.connect({ ...account, permissions: { otp: true, read: false, send: false } });
    const controller = new AbortController();
    transport.codeCandidates.mockImplementation(() => new Promise(() => {}));
    const result = mail.readCode({ sender, reference, notBefore: Date.now() - 1000, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("Could not check for a matching code");
    expect(transport.codeCandidates).toHaveBeenCalledWith(expect.anything(), sender, expect.any(Number), controller.signal);
  });

  it("rejects a changed account and header injection before SMTP", async () => {
    const first = await mail.connect(account);
    await mail.connect({ ...account, email: "second@gmail.com" });
    mail.setPermissions({ send: true });
    const outbound = { to: sender, subject: "Re: Your message", text: "My answer", inReplyTo: "<original@example.com>" };
    await expect(mail.send({ ...outbound, accountId: first.accountId })).rejects.toThrow("mailbox changed");
    await expect(mail.send({ ...outbound, to: "booking@example.com, cc@example.com" })).rejects.toThrow();
    await expect(mail.send({ ...outbound, subject: "Hello\r\nBcc: cc@example.com" })).rejects.toThrow();
    expect(transport.send).not.toHaveBeenCalled();
    await expect(mail.send(outbound)).resolves.toBeUndefined();
    expect(transport.send).toHaveBeenCalledOnce();
    expect(transport.send.mock.calls[0]?.[1]).toEqual(outbound);
  }, 15_000);

  it("checks the send permission again after network preparation", async () => {
    await mail.connect({ ...account, permissions: { read: false, otp: false, send: true } });
    const dispatch = vi.fn();
    transport.send.mockImplementationOnce(async (_account, _message, authorize) => {
      new MailService(stateDir, "test passphrase", transport).setPermissions({ send: false });
      authorize?.();
      dispatch();
    });
    await expect(mail.send({ to: sender, subject: "Hello", text: "text" })).rejects.toThrow("outgoing mail service did not confirm");
    expect(mail.settings()?.permissions.send).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps POP3 reading separate from IMAP code access and rejects unsafe credentials routing", async () => {
    const pop = { protocol: "pop3", host: "pop.gmail.com", port: 995 } as const;
    await expect(mail.connect({ ...account, incoming: pop, auth: "gmail-oauth" })).rejects.toThrow("Google OAuth credentials");
    await expect(mail.connect({ ...account, incoming: { ...pop, port: 110 } })).rejects.toThrow("implicit TLS");
    await expect(mail.connect({ ...account, incoming: { ...pop, host: "127.0.0.1" } })).rejects.toThrow("public mail server hostname");
    expect(transport.verify).not.toHaveBeenCalled();
    await mail.connect({ ...account, incoming: pop });
    mail.setPermissions({ read: true });
    expect(() => mail.setPermissions({ otp: true })).toThrow("Code access requires IMAP");
    await expect(mail.list()).resolves.toHaveLength(1);
    mail.disconnect();
    expect(mail.settings()).toBeNull();
  });
});
