import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export interface IncomingMail {
  protocol: "imap" | "pop3";
  host: string;
  port: number;
}

export type OutgoingMail = { transport?: "smtp"; host: string; port: number }
  | { transport: "gmail-api"; host?: never; port?: never };

export interface MailSetup {
  email: string;
  incoming?: IncomingMail;
  outgoing?: OutgoingMail;
  graph?: true;
  graphIncomingOnly?: true;
  provider: string;
  source: "preset" | "dns" | "manual";
}

export interface MailPermissions {
  read: boolean;
  otp: boolean;
  send: boolean;
}

export type MailAuth = "password" | "gmail-oauth" | "microsoft-oauth";

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const MICROSOFT_TOKEN_ENDPOINT = `${MICROSOFT_AUTHORITY}/token`;
export const MICROSOFT_DEVICE_CODE_ENDPOINT = `${MICROSOFT_AUTHORITY}/devicecode`;
const MICROSOFT_GRAPH_READ_SCOPES = ["User.Read", "Mail.Read"] as const;
export const MICROSOFT_GRAPH_SCOPES = [...MICROSOFT_GRAPH_READ_SCOPES, "Mail.Send"] as const;

export function microsoftGraphScopes(incomingOnly = false): readonly string[] {
  return incomingOnly ? MICROSOFT_GRAPH_READ_SCOPES : MICROSOFT_GRAPH_SCOPES;
}

export function microsoftMailScopes(incomingOnly = false): string {
  return [...microsoftGraphScopes(incomingOnly).map(scope => `https://graph.microsoft.com/${scope}`), "offline_access"].join(" ");
}

export const MICROSOFT_MAIL_SCOPES = microsoftMailScopes();

export interface GmailOAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface MailConnection extends MailSetup {
  username?: string;
  password: string;
  auth?: MailAuth;
  gmailClient?: GmailOAuthClient;
  microsoftClientId?: string;
  permissions?: MailPermissions;
}

export interface MailSettings extends MailSetup {
  accountId: string;
  username: string;
  auth: MailAuth;
  permissions: MailPermissions;
}

export interface StoredMail extends MailSettings {
  password: string;
  gmailClient?: GmailOAuthClient;
  microsoftClientId?: string;
}

export function microsoftOAuthClientId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Use a Microsoft application client ID in UUID format.");
  }
  return value.toLowerCase();
}

export function canReadMail(setup: Pick<MailSetup, "graph" | "incoming">): boolean {
  return setup.graph === true || setup.incoming !== undefined;
}

export function canReadMailCode(setup: Pick<MailSetup, "graph" | "incoming">): boolean {
  return setup.graph === true || setup.incoming?.protocol === "imap";
}

export function canSendMail(setup: Pick<MailSetup, "graph" | "graphIncomingOnly" | "outgoing">): boolean {
  return setup.graph === true ? setup.graphIncomingOnly !== true : setup.outgoing !== undefined;
}

export function gmailOAuthClient(clientId: unknown, clientSecret: unknown): GmailOAuthClient {
  if (typeof clientId !== "string" || clientId.length > 512 || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)
      || typeof clientSecret !== "string" || !/^[A-Za-z0-9_-]{8,512}$/.test(clientSecret)) {
    throw new Error("Invalid Google Desktop app client credentials.");
  }
  return { clientId, clientSecret };
}

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
}

export interface MailMessage extends MailSummary {
  text: string;
  messageId?: string;
  replyTo?: string;
  gmailThreadId?: string;
}

export interface MailSend {
  accountId?: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  gmailThreadId?: string;
}

export interface MailCodeRequest {
  accountId?: string;
  signal?: AbortSignal;
  sender: string;
  subjectIncludes?: string;
  /** Request-specific value already known to the caller and present in the message. */
  reference: string;
  /** Epoch milliseconds taken just before requesting the confirmation code. */
  notBefore: number;
}

export interface MailCodeCandidate extends MailMessage {
  receivedAt: number;
  /** Decoded body within the non-truncated limit used for code extraction. */
  codeText?: string;
}

export function mailHost(value: string): string {
  const input = value.trim().replace(/\.$/, "");
  const host = /[\s/?#@:[\]\\]/.test(input) ? "" : domainToASCII(input).toLowerCase();
  if (!host || host.length > 253 || isIP(host) || !host.includes(".") ||
      host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Use a public mail server hostname.");
  }
  return host;
}

export function mailAddress(value: string): string {
  const input = value.trim();
  const at = input.indexOf("@");
  const local = input.slice(0, at);
  if (input.length > 254 || at < 1 || local.length > 64 ||
      !/^[\w!#$%&'*+\-/=?^`{|}~]+(?:\.[\w!#$%&'*+\-/=?^`{|}~]+)*$/.test(local)) {
    throw new Error("Use one valid email address.");
  }
  return `${local}@${mailHost(input.slice(at + 1))}`;
}

export function cleanMessageId(value?: string): string | undefined {
  return value && value.length <= 255 && /^<[^<>@\s\u0000-\u001f\u007f]+@[^<>@\s\u0000-\u001f\u007f]+>$/.test(value) ? value : undefined;
}

export function cleanMailText(text: string, limit: number): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, limit);
}

export function isGraphMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_+/-]{1,1024}={0,2}$/.test(value);
}
