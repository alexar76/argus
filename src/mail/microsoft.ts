import { fetchNoRedirect } from "../credential-fetch.js";
import {
  MICROSOFT_TOKEN_ENDPOINT, canSendMail,
  cleanMailText, cleanMessageId, isGraphMessageId, mailAddress, microsoftGraphScopes, microsoftMailScopes, microsoftOAuthClientId,
  type MailCodeCandidate, type MailMessage, type MailSummary, type StoredMail,
} from "./types.js";

const GRAPH_API = "https://graph.microsoft.com/v1.0/me";
const INBOX = "/mailFolders/inbox/messages";
const SUMMARY_FIELDS = "id,from,subject,receivedDateTime";
const MESSAGE_FIELDS = `${SUMMARY_FIELDS},body,internetMessageId,replyTo`;
const REQUEST_MS = 12_000;
const BODY_LIMIT = 512 * 1024;
const CODE_TEXT_LIMIT = 16_384;
const MAX_CODE_MESSAGES = 8;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function timeout(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(REQUEST_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function readJson(response: Response, limit = BODY_LIMIT): Promise<JsonObject> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Microsoft mail service declined the request.");
  }
  if (!response.body) throw new Error("Microsoft mail service returned no result.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new Error("Microsoft mail response is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return object(JSON.parse(Buffer.concat(chunks, length).toString("utf8"))); }
  catch { throw new Error("Microsoft mail service returned invalid JSON."); }
}

async function accessToken(account: StoredMail, signal?: AbortSignal): Promise<string> {
  if (!account.graph || account.auth !== "microsoft-oauth") throw new Error("Microsoft mail is not configured.");
  const response = await fetchNoRedirect(MICROSOFT_TOKEN_ENDPOINT, {
    method: "POST",
    body: new URLSearchParams({
      client_id: microsoftOAuthClientId(account.microsoftClientId), grant_type: "refresh_token",
      refresh_token: account.password, scope: microsoftMailScopes(account.graphIncomingOnly),
    }),
    signal: timeout(signal),
  });
  const token = await readJson(response, 64 * 1024);
  if (typeof token.access_token !== "string" || token.access_token.length > 32_768 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token.access_token)
      || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
    throw new Error("Microsoft did not return a valid access token.");
  }
  if (token.scope !== undefined) {
    const scopes = typeof token.scope === "string" ? token.scope.toLowerCase().split(/\s+/) : [];
    const hasScope = (name: string) => scopes.includes(name.toLowerCase()) || scopes.includes(`https://graph.microsoft.com/${name.toLowerCase()}`);
    if (!microsoftGraphScopes(account.graphIncomingOnly).every(hasScope)) {
      throw new Error("Microsoft mail permissions are incomplete.");
    }
    if (account.graphIncomingOnly && hasScope("Mail.Send")) throw new Error("Microsoft granted sending access to an incoming-only mailbox.");
  }
  // Microsoft keeps the original device refresh token valid until expiry/revocation. Do not rewrite a live permission vault here.
  return token.access_token;
}

function graphRequest(token: string, path: string, query?: Record<string, string>, signal?: AbortSignal, mime?: Buffer) {
  const url = new URL(GRAPH_API + path);
  if (query) url.search = new URLSearchParams(query).toString();
  return fetchNoRedirect(url, {
    method: mime ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
      ...(mime ? { "content-type": "text/plain" } : { accept: "application/json" }),
    },
    body: mime?.toString("base64"),
    signal: timeout(signal),
  });
}

function emailAddress(value: unknown): string {
  try { return typeof value === "string" ? mailAddress(value) : ""; }
  catch { return ""; }
}

function graphAddress(value: unknown): string {
  return emailAddress(object(object(value).emailAddress).address);
}

function graphSummary(row: JsonObject): MailSummary {
  if (!isGraphMessageId(row.id)) throw new Error("Microsoft returned an invalid message identifier.");
  const time = typeof row.receivedDateTime === "string" ? Date.parse(row.receivedDateTime) : NaN;
  return {
    id: `graph:${row.id}`, from: graphAddress(row.from), date: Number.isFinite(time) ? new Date(time).toISOString() : "",
    subject: typeof row.subject === "string" ? cleanMailText(row.subject, 500) : "",
  };
}

function graphMessage(row: JsonObject): MailCodeCandidate {
  const body = object(row.body);
  if (typeof body.contentType !== "string" || body.contentType.toLowerCase() !== "text" || typeof body.content !== "string") {
    throw new Error("Microsoft did not return a plain-text message body.");
  }
  const summary = graphSummary(row);
  return {
    ...summary, receivedAt: Date.parse(summary.date), text: cleanMailText(body.content, 12_000),
    messageId: typeof row.internetMessageId === "string" ? cleanMessageId(row.internetMessageId) : undefined,
    replyTo: Array.isArray(row.replyTo) && row.replyTo.length === 1 ? graphAddress(row.replyTo[0]) || undefined : undefined,
    codeText: body.content.length <= CODE_TEXT_LIMIT && typeof row.subject === "string" && row.subject.length <= 500
      ? cleanMailText(body.content, CODE_TEXT_LIMIT) : undefined,
  };
}

async function getMessage(token: string, id: string, signal?: AbortSignal): Promise<MailCodeCandidate> {
  const rawId = id.startsWith("graph:") ? id.slice("graph:".length) : "";
  if (!isGraphMessageId(rawId)) throw new Error("Select a current Outlook inbox message.");
  const result = graphMessage(await readJson(await graphRequest(token, `${INBOX}/${encodeURIComponent(rawId)}`, { $select: MESSAGE_FIELDS }, signal)));
  if (result.id !== id) throw new Error("Microsoft returned a different message.");
  return result;
}

export const microsoftGraphMail = {
  async verify(account: StoredMail): Promise<void> {
    const token = await accessToken(account);
    const profile = await readJson(await graphRequest(token, "", { $select: "mail,userPrincipalName" }), 64 * 1024);
    const primary = emailAddress(profile.mail) || emailAddress(profile.userPrincipalName);
    if (!primary || primary.toLowerCase() !== account.email.toLowerCase()) {
      throw new Error("The Microsoft OAuth profile does not match the configured mailbox.");
    }
    const inbox = await readJson(await graphRequest(token, "/mailFolders/inbox", { $select: "id" }), 64 * 1024);
    if (typeof inbox.id !== "string" || !inbox.id) throw new Error("Microsoft did not confirm the mailbox inbox.");
  },

  async list(account: StoredMail, limit: number): Promise<MailSummary[]> {
    const token = await accessToken(account);
    const result = await readJson(await graphRequest(token, INBOX, {
      $select: SUMMARY_FIELDS, $orderby: "receivedDateTime desc", $top: String(limit),
    }));
    if (!Array.isArray(result.value) || result.value.length > limit) throw new Error("Microsoft returned an invalid message page.");
    return result.value.map(row => graphSummary(object(row)));
  },

  async read(account: StoredMail, id: string): Promise<MailMessage> {
    const { codeText: _codeText, receivedAt: _receivedAt, ...message } = await getMessage(await accessToken(account), id);
    return message;
  },

  async codeCandidates(account: StoredMail, sender: string, notBefore: number, signal?: AbortSignal): Promise<MailCodeCandidate[]> {
    const token = await accessToken(account, signal);
    const filter = `receivedDateTime ge ${new Date(notBefore).toISOString()} and from/emailAddress/address eq '${sender.replaceAll("'", "''")}'`;
    const result = await readJson(await graphRequest(token, INBOX, {
      $select: SUMMARY_FIELDS, $filter: filter, $top: String(MAX_CODE_MESSAGES + 1),
    }, signal));
    if (!Array.isArray(result.value) || result.value.length > MAX_CODE_MESSAGES || result["@odata.nextLink"]) {
      throw new Error("Too many Outlook messages matched the code request.");
    }
    const candidates: MailCodeCandidate[] = [];
    for (const row of result.value) {
      const match = graphSummary(object(row));
      if (match.from !== sender || !match.date || Date.parse(match.date) < notBefore) continue;
      const message = await getMessage(token, match.id, signal);
      if (message.from === sender && message.receivedAt >= notBefore) candidates.push(message);
    }
    return candidates;
  },

  async send(account: StoredMail, mime: Buffer, authorize?: () => void): Promise<void> {
    if (!canSendMail(account)) throw new Error("Microsoft mail is configured for incoming mail only.");
    const token = await accessToken(account);
    authorize?.();
    const response = await graphRequest(token, "/sendMail", undefined, undefined, mime);
    await response.body?.cancel().catch(() => {});
    if (response.status !== 202) throw new Error("Microsoft Graph did not accept the message.");
  },
};
