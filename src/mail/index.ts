import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decryptToken, encryptToken } from "../economy/keystore.js";
import { defaultMailTransport, type MailTransport } from "./transport.js";
import {
  canReadMail, canReadMailCode, canSendMail, cleanMessageId, gmailOAuthClient, isGraphMessageId, mailAddress, mailHost, microsoftOAuthClientId,
  type MailCodeCandidate, type MailCodeRequest, type MailConnection,
  type MailMessage, type MailPermissions, type MailSend, type MailSettings, type MailSummary, type StoredMail,
} from "./types.js";

export { discoverMail } from "./discovery.js";
export {
  canReadMail, canReadMailCode, canSendMail, mailAddress, microsoftOAuthClientId,
  MICROSOFT_DEVICE_CODE_ENDPOINT, MICROSOFT_MAIL_SCOPES, MICROSOFT_TOKEN_ENDPOINT,
} from "./types.js";
export type { MailTransport } from "./transport.js";
export type {
  IncomingMail, MailAuth, MailCodeCandidate, MailCodeRequest, MailConnection, MailMessage, MailPermissions,
  MailSend, MailSettings, MailSetup, MailSummary, OutgoingMail, StoredMail,
} from "./types.js";

const STORAGE_CONTEXT = "argus-mail:v1:";
const MAX_SETTINGS_BYTES = 32 * 1024;
const CODE_MAX_AGE_MS = 15 * 60_000;
const DISABLED_PERMISSIONS = { read: false, otp: false, send: false };
const GRANT_KEYS = ["read", "otp", "send"] as const;
const permissionRequirements = {
  read: { can: canReadMail, reason: "Configure a readable mailbox before enabling mail reading." },
  otp: { can: canReadMailCode, reason: "Code access requires IMAP or Microsoft Graph server arrival times." },
  send: { can: canSendMail, reason: "Configure outgoing mail before enabling sending." },
};

function publicSettings({ password: _password, gmailClient: _gmailClient, microsoftClientId: _microsoftClientId, ...settings }: StoredMail): MailSettings {
  return {
    ...settings,
    incoming: settings.incoming && { ...settings.incoming },
    outgoing: settings.outgoing && { ...settings.outgoing },
    permissions: { ...settings.permissions },
  };
}

function normalizePermissions(value: Partial<MailPermissions>): MailPermissions {
  const result = { ...DISABLED_PERMISSIONS };
  for (const key of GRANT_KEYS) {
    const permission = value[key];
    if (permission !== undefined && typeof permission !== "boolean") throw new Error("Invalid mail permission.");
    result[key] = permission === true;
  }
  return result;
}

function checkPermissions(account: StoredMail): void {
  for (const permission of GRANT_KEYS) {
    const { can, reason } = permissionRequirements[permission];
    if (account.permissions[permission] && !can(account)) throw new Error(reason);
  }
}

function normalizeAccount(input: MailConnection, accountId: string): StoredMail {
  const email = mailAddress(input.email);
  const username = input.username?.trim() || email;
  const auth = input.auth ?? "password";
  if (username.length > 254 || /[\r\n\0]/.test(username) || !input.password || input.password.length > 4096 || /[\r\n\0]/.test(input.password)) {
    throw new Error("Invalid mail credentials.");
  }
  if (auth !== "password" && auth !== "gmail-oauth" && auth !== "microsoft-oauth") throw new Error("Unknown mail authentication method.");
  if (input.source !== "manual" && input.source !== "dns" && input.source !== "preset") throw new Error("Invalid mail settings source.");
  if ((input.graph !== undefined && input.graph !== true) || (input.graph === true) !== (auth === "microsoft-oauth")) {
    throw new Error("Microsoft Graph requires Microsoft OAuth.");
  }
  const graph = input.graph;
  if (graph && (input.incoming || input.outgoing || mailAddress(username).toLowerCase() !== email.toLowerCase())) {
    throw new Error("Use Microsoft Graph only with the mailbox email and no separate mail servers.");
  }
  const graphIncomingOnly = input.graphIncomingOnly;
  if (graphIncomingOnly !== undefined && (!graph || graphIncomingOnly !== true)) {
    throw new Error("Microsoft Graph incoming-only access requires Microsoft OAuth.");
  }
  const incoming = input.incoming && { ...input.incoming, host: mailHost(input.incoming.host) };
  const outgoing = input.outgoing?.transport === "gmail-api" ? { transport: "gmail-api" as const }
    : input.outgoing && { ...input.outgoing, host: mailHost(input.outgoing.host) };
  if (!graph && !incoming && !outgoing) throw new Error("Configure at least one incoming or outgoing mail server.");
  if (incoming && !((incoming.protocol === "imap" && incoming.port === 993) || (incoming.protocol === "pop3" && incoming.port === 995))) {
    throw new Error("Use implicit TLS for IMAP (993) or POP3 (995).");
  }
  if (outgoing?.transport === "gmail-api" && auth !== "gmail-oauth") throw new Error("Gmail API delivery requires Google OAuth.");
  if (outgoing && outgoing.transport !== "gmail-api" && outgoing.port !== 465 && outgoing.port !== 587) throw new Error("Use SMTP TLS on 465 or STARTTLS on 587.");
  if (auth === "gmail-oauth" && ((incoming && (incoming.protocol !== "imap" || incoming.host !== "imap.gmail.com")) ||
      (outgoing && outgoing.transport !== "gmail-api" && outgoing.host !== "smtp.gmail.com"))) {
    throw new Error("Google OAuth credentials can only be used with Google's Gmail IMAP and SMTP servers.");
  }
  if (input.gmailClient !== undefined && auth !== "gmail-oauth") throw new Error("Google client credentials require Gmail OAuth.");
  const gmailClient = input.gmailClient === undefined ? undefined
    : gmailOAuthClient(input.gmailClient.clientId, input.gmailClient.clientSecret);
  if (input.microsoftClientId !== undefined && !graph) throw new Error("Microsoft client IDs require Microsoft OAuth.");
  const microsoftClientId = graph ? microsoftOAuthClientId(input.microsoftClientId) : undefined;
  const account: StoredMail = {
    accountId, email, username, auth, incoming, outgoing, ...(graph ? { graph } : {}),
    ...(graphIncomingOnly ? { graphIncomingOnly } : {}), password: input.password, gmailClient, microsoftClientId,
    source: input.source, provider: String(input.provider || email.split("@")[1]).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100),
    permissions: normalizePermissions(input.permissions ?? {}),
  };
  checkPermissions(account);
  return account;
}

function readEncrypted(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to open the private mail settings file.");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_SETTINGS_BYTES) {
      throw new Error("Mail settings must be a private regular file (mode 600).");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function atomicSave(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

const CODE_LABEL = String.raw`(?:one[- ]time (?:pass(?:code|word)|pin|code)|(?:verification|confirmation|security|login) code|otp|код(?: подтверждения| проверки)?)`;

function matchingCode(candidates: MailCodeCandidate[], request: MailCodeRequest, now: number): string | null {
  // The caller supplies a newly generated, URL-safe booking reference. Match it as a whole token.
  const reference = new RegExp(`(?<![A-Za-z0-9_-])${request.reference}(?![A-Za-z0-9_-])`);
  const forward = new RegExp(`(?<![\\p{L}\\p{N}_])${CODE_LABEL}\\s*(?:(?:is|equals)\\s+|[:#-]\\s*)?([0-9]{6})(?![0-9])`, "giu");
  const reverse = new RegExp(`(?<![0-9])([0-9]{6})\\s+is\\s+your\\s+${CODE_LABEL}(?![\\p{L}\\p{N}_])`, "giu");
  const codes = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.codeText === undefined || candidate.from !== request.sender || candidate.receivedAt < request.notBefore || candidate.receivedAt > now + 5_000 ||
        (request.subjectIncludes && !candidate.subject.toLowerCase().includes(request.subjectIncludes.toLowerCase()))) continue;
    const text = `${candidate.subject}\n${candidate.codeText}`;
    if (!reference.test(text)) continue;
    for (const match of [...text.matchAll(forward), ...text.matchAll(reverse)]) {
      if (match[1]) codes.add(match[1]);
    }
  }
  return codes.size === 1 ? [...codes][0]! : null;
}

async function withCodeDeadline<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return action();
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([abort, action()]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}

export class MailService {
  private readonly file: string;
  private unlocked?: { encrypted: string; account: StoredMail };

  constructor(
    stateDir: string,
    private readonly passphrase = process.env.ARGUS_KEYSTORE_PASSPHRASE,
    private readonly transport: MailTransport = defaultMailTransport,
  ) {
    this.file = join(stateDir, "mail-account.json");
  }

  private requirePassphrase(): string {
    if (!this.passphrase?.trim()) throw new Error("Set ARGUS_KEYSTORE_PASSPHRASE on the ARGUS host to unlock mail.");
    return this.passphrase;
  }

  private save(account: StoredMail): void {
    const blob = encryptToken(STORAGE_CONTEXT + JSON.stringify(account), this.requirePassphrase(), "mail-account");
    const encrypted = JSON.stringify(blob) + "\n";
    atomicSave(this.file, encrypted);
    this.unlocked = { encrypted, account };
  }

  private load(): StoredMail | null {
    const raw = readEncrypted(this.file);
    // Always read the vault before authorizing an operation. Another process may have revoked access.
    if (this.unlocked && this.unlocked.encrypted === raw) return this.unlocked.account;
    this.unlocked = undefined;
    if (!raw) return null;
    const passphrase = this.requirePassphrase();
    try {
      const blob = JSON.parse(raw) as Parameters<typeof decryptToken>[0];
      if (blob.v !== 1 || blob.kdf !== "scrypt" || blob.N !== 32768 || blob.r !== 8 || blob.p !== 1) throw new Error();
      let contents: string;
      try {
        contents = decryptToken(blob, passphrase, "mail-account");
      } catch {
        // Legacy mail vaults used the Telegram encryption purpose. The
        // authenticated plaintext prefix below is required for both formats.
        contents = decryptToken(blob, passphrase);
      }
      if (!contents.startsWith(STORAGE_CONTEXT)) throw new Error();
      const account = JSON.parse(contents.slice(STORAGE_CONTEXT.length)) as StoredMail;
      if (!/^[0-9a-f-]{36}$/.test(account.accountId)) throw new Error();
      const normalized = normalizeAccount(account, account.accountId);
      this.unlocked = { encrypted: raw, account: normalized };
      return normalized;
    } catch {
      throw new Error("Unable to unlock the mail settings. Check the keystore passphrase on the ARGUS host.");
    }
  }

  private requireAccount(permission?: keyof MailPermissions, accountId?: string): StoredMail {
    const account = this.load();
    if (!account) throw new Error("No mailbox is connected.");
    if (accountId && account.accountId !== accountId) throw new Error("The connected mailbox changed. Start the mail action again.");
    if (permission) {
      if (!account.permissions[permission]) throw new Error(`Mail ${permission} permission is disabled.`);
      const { can, reason } = permissionRequirements[permission];
      if (!can(account)) throw new Error(reason);
    }
    return account;
  }

  settings(): MailSettings | null {
    const account = this.load();
    return account ? publicSettings(account) : null;
  }

  async connect(input: MailConnection): Promise<MailSettings> {
    this.requirePassphrase();
    const previous = readEncrypted(this.file);
    if (previous !== undefined) this.load();
    const account = normalizeAccount(input, randomUUID());
    try {
      await this.transport.verify(account);
    } catch {
      throw new Error("Mail server connection or authentication failed. Check server settings and your credential locally.");
    }
    if (readEncrypted(this.file) !== previous) throw new Error("Mail settings changed during connection. Start setup again.");
    this.save(account);
    return publicSettings(account);
  }

  setPermissions(permissions: Partial<MailPermissions>, expectedAccountId?: string): MailSettings {
    const account = this.requireAccount(undefined, expectedAccountId);
    const updated = { ...account, permissions: normalizePermissions({ ...account.permissions, ...permissions }) };
    checkPermissions(updated);
    this.save(updated);
    return publicSettings(updated);
  }

  disconnect(): void {
    this.unlocked = undefined;
    try { unlinkSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async list(limit = 5, accountId?: string): Promise<MailSummary[]> {
    const account = this.requireAccount("read", accountId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Choose between 1 and 20 messages.");
    let results: MailSummary[];
    try { results = await this.transport.list(account, limit); }
    catch { throw new Error("Could not list the inbox. Check the incoming server and credential locally."); }
    this.requireAccount("read", account.accountId);
    return results;
  }

  async read(id: string, accountId?: string): Promise<MailMessage> {
    const account = this.requireAccount("read", accountId);
    const accepted = account.graph ? id.startsWith("graph:") && isGraphMessageId(id.slice("graph:".length))
      : account.incoming?.protocol === "imap" ? /^imap:[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/.test(id) : /^pop3:[A-Za-z0-9_-]{1,94}$/.test(id);
    if (!accepted) {
      throw new Error("Select an inbox message first.");
    }
    let result: MailMessage;
    try { result = await this.transport.read(account, id); }
    catch { throw new Error("Could not open the message. Refresh the inbox or check the incoming server locally."); }
    this.requireAccount("read", account.accountId);
    return result;
  }

  async readCode(input: MailCodeRequest): Promise<string | null> {
    input.signal?.throwIfAborted();
    const account = this.requireAccount("otp", input.accountId);
    const now = Date.now();
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(input.reference) || !Number.isFinite(input.notBefore) ||
        input.notBefore < now - CODE_MAX_AGE_MS || input.notBefore > now ||
        (input.subjectIncludes && input.subjectIncludes.length > 150)) throw new Error("Invalid code request scope.");
    const request = { ...input, sender: mailAddress(input.sender), notBefore: Math.floor(input.notBefore / 1000) * 1000 };
    let candidates: MailCodeCandidate[];
    try {
      candidates = await withCodeDeadline(
        () => this.transport.codeCandidates(account, request.sender, request.notBefore, request.signal), request.signal,
      );
    }
    catch { throw new Error("Could not check for a matching code. Check the incoming server locally."); }
    input.signal?.throwIfAborted();
    this.requireAccount("otp", account.accountId);
    const completedAt = Date.now();
    return completedAt - input.notBefore <= CODE_MAX_AGE_MS ? matchingCode(candidates, request, completedAt) : null;
  }

  async send(input: MailSend): Promise<void> {
    const account = this.requireAccount("send", input.accountId);
    const to = mailAddress(input.to);
    if (input.subject.length > 500 || /[\r\n\0]/.test(input.subject) || !input.text.trim() ||
        input.text.length > 12_000 || /\0/.test(input.text)) throw new Error("Invalid mail subject or text.");
    const inReplyTo = cleanMessageId(input.inReplyTo);
    if (input.inReplyTo && !inReplyTo) throw new Error("Invalid reply message identifier.");
    const gmailThreadId = account.outgoing?.transport === "gmail-api" && input.gmailThreadId && /^[0-9a-f]{1,16}$/.test(input.gmailThreadId)
      ? input.gmailThreadId : undefined;
    try {
      await this.transport.send(account, { to, subject: input.subject, text: input.text, inReplyTo, ...(gmailThreadId ? { gmailThreadId } : {}) },
        () => { this.requireAccount("send", account.accountId); });
    }
    catch { throw new Error("The outgoing mail service did not confirm the send. Check your mail provider before trying again."); }
  }
}
