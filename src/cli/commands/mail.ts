import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ArgusConfig } from "../../config.js";
import { canReadMailCode, discoverMail, mailAddress, MailService, microsoftOAuthClientId, type MailSetup } from "../../mail/index.js";
import { readSecretLine } from "../../setup/secret-prompt.js";
import { describeMailSetup } from "../../telegram/mail.js";
import type { Args } from "../args.js";
import { authorizeGmail, readGoogleDesktopClient } from "./mail-oauth.js";
import { authorizeMicrosoftMail } from "./mail-microsoft-oauth.js";

export async function cmdMail(config: ArgusConfig, args: Args): Promise<number> {
  const mail = new MailService(config.stateDir);
  const [sub = "status", first, second, extra] = args.rest;
  try {
    if (extra) return usage();
    switch (sub) {
      case "status": {
        const settings = mail.settings();
        if (!settings) {
          console.log("Mail is disconnected. Run `argus mail setup`.");
          return 0;
        }
        console.log(describeMailSetup(settings));
        const authentication = {
          "gmail-oauth": "Google OAuth",
          "microsoft-oauth": "Microsoft OAuth",
          password: "password or app password",
        };
        console.log(`Authentication: ${authentication[settings.auth]}`);
        console.log(`ARGUS permissions · read ${state(settings.permissions.read)} · verification codes ${state(settings.permissions.otp)} · send ${state(settings.permissions.send)}`);
        return 0;
      }
      case "discover":
        if (!first || second) return usage();
        console.log(describeMailSetup(await discoverMail(first)));
        return 0;
      case "setup":
        if (second) return usage();
        return await setupMail(mail, first, args.flags);
      case "check-otp":
        if (!first || second) return usage();
        return await checkMailOtp(mail, first, console.log);
      case "check-read":
        if (!first || !second) return usage();
        await readTestMessage(mail, first, second);
        console.log("PASS: the selected test message was readable.");
        return 0;
      case "check-reply":
        if (!first || !second || args.flags.yes === true) return usage();
        if (!stdin.isTTY || !stdout.isTTY) {
          console.error("Reply verification requires a private interactive terminal for the owner to confirm the exact reply.");
          return 1;
        }
        return await checkMailReply(mail, first, second, confirmTestReply, console.log);
      case "permissions": {
        if ((first !== "read" && first !== "otp" && first !== "send") || (second !== "on" && second !== "off")) return usage();
        const settings = mail.setPermissions({ [first]: second === "on" });
        console.log(`${first} ${state(settings.permissions[first])}`);
        return 0;
      }
      case "disconnect":
        if (args.flags.yes !== true || first) return usage();
        mail.disconnect();
        console.log("Mail connection removed from ARGUS.");
        return 0;
      default: return usage();
    }
  } catch {
    console.error("Mail command failed. Check the email address, TLS settings, credentials, and ARGUS_KEYSTORE_PASSPHRASE.");
    return 1;
  }
}

export async function readTestMessage(mail: Pick<MailService, "settings" | "list" | "read">, senderAddress: string, subject: string) {
  const sender = mailAddress(senderAddress);
  const account = mail.settings();
  if (!account?.permissions.read || !subject || subject.length > 200 || /\p{C}/u.test(subject)) {
    throw new Error("Enable inbox reading and supply the exact subject of the test message.");
  }
  const messages = await mail.list(20, account.accountId);
  const matches = messages.filter((message) => message.from === sender && message.subject === subject);
  if (matches.length !== 1) throw new Error("The recent inbox does not contain exactly one matching test message.");
  const message = await mail.read(matches[0]!.id, account.accountId);
  if (message.from !== sender || message.subject !== subject) throw new Error("The selected message changed.");
  return { accountId: account.accountId, message };
}

export async function checkMailReply(
  mail: Pick<MailService, "settings" | "list" | "read" | "send">,
  sender: string,
  subject: string,
  review: (preview: string) => Promise<string>,
  show: (message: string) => void,
): Promise<number> {
  if (!mail.settings()?.permissions.send) {
    show("Mail sending is disabled.");
    return 1;
  }
  const { accountId, message } = await readTestMessage(mail, sender, subject);
  if (!message.messageId) throw new Error("The test message does not have a reply identifier.");
  const reply = { accountId, to: message.from, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: "ARGUS test reply. The mailbox owner reviewed and confirmed this message.", inReplyTo: message.messageId,
    ...(message.gmailThreadId ? { gmailThreadId: message.gmailThreadId } : {}) };
  const answer = await review(`Review the test reply\nTo: ${reply.to}\nSubject: ${reply.subject}\n\n${reply.text}`);
  if (answer !== "SEND") {
    show("Test reply cancelled.");
    return 1;
  }
  try { await mail.send(reply); }
  catch {
    show("Send could not be confirmed. Check the mailbox before trying again.");
    return 1;
  }
  show("PASS: the outgoing mail service accepted the confirmed test reply. Verify receipt in the test sender's mailbox.");
  return 0;
}

async function confirmTestReply(preview: string): Promise<string> {
  console.log(preview);
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question("Type SEND within five minutes to send this exact test reply: ", { signal: AbortSignal.timeout(5 * 60_000) }); }
  catch { return ""; }
  finally { rl.close(); }
}

async function setupMail(mail: MailService, email: string | undefined, flags: Args["flags"]): Promise<number> {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error("Mail setup requires a private interactive terminal on the ARGUS host.");
    return 1;
  }
  if (!process.env.ARGUS_KEYSTORE_PASSPHRASE?.trim()) {
    console.error("Set ARGUS_KEYSTORE_PASSPHRASE on the ARGUS host before setting up mail. ARGUS uses it to encrypt the mailbox credential.");
    return 1;
  }
  if (flags.force !== true && mail.settings()) {
    console.error("A mailbox is already connected. Use `argus mail setup --force` to replace it.");
    return 1;
  }
  const clientFile = flags["gmail-client"];
  const portFlag = flags["oauth-port"];
  const apiFlag = flags["gmail-send-api"];
  const microsoftClient = flags["microsoft-client-id"];
  const appPassword = flags["app-password"] === true;
  const incomingOnly = flags["incoming-only"] === true;
  if (typeof flags["app-password"] === "string" || typeof flags["incoming-only"] === "string"
    || (appPassword && (clientFile !== undefined || portFlag !== undefined || apiFlag !== undefined || microsoftClient !== undefined))
    || (incomingOnly && apiFlag !== undefined)) return usage();
  if (microsoftClient !== undefined) {
    if (typeof microsoftClient !== "string" || clientFile !== undefined || portFlag !== undefined || apiFlag !== undefined) return usage();
    return setupMicrosoftMail(mail, email, microsoftClient, { incomingOnly });
  }
  const gmailApi = apiFlag === true;
  const port = typeof portFlag === "string" && /^\d{4,5}$/.test(portFlag) ? Number(portFlag) : undefined;
  if (clientFile === true || typeof apiFlag === "string" || (portFlag !== undefined && (port === undefined || port < 1024 || port > 65535))) return usage();
  let imported: ReturnType<typeof readGoogleDesktopClient> | undefined;
  if (typeof clientFile === "string") {
    try { imported = readGoogleDesktopClient(clientFile); }
    catch {
      console.error("Could not import a Google Desktop app OAuth JSON. Use the original downloaded file, owned by this user and readable only by this user (chmod 600).");
      return 1;
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  let setup: MailSetup;
  let username: string;
  let oauth = false;
  const { clientId, clientSecret } = imported ?? {
    clientId: process.env.ARGUS_GMAIL_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.ARGUS_GMAIL_CLIENT_SECRET?.trim() ?? "",
  };
  try {
    const address = email ?? (await rl.question("Mailbox address: ")).trim();
    setup = await discoverMail(address);
    if (setup.graph) {
      if (imported || port || gmailApi || appPassword) {
        console.error("For Outlook.com use the Microsoft Entra application client ID.");
        return 1;
      }
      const id = (await rl.question("Microsoft Entra Application (client) ID: ")).trim();
      rl.close();
      return await setupMicrosoftMail(mail, setup.email, id, { incomingOnly, showSettings: false });
    }
    if (incomingOnly) setup = { ...setup, outgoing: undefined };
    console.log(describeMailSetup(setup));
    const answer = (await rl.question("Use these settings? [Y/manual/cancel]: ")).trim().toLowerCase();
    if (!["", "y", "yes", "manual"].includes(answer)) return 1;
    if (answer === "manual" || (!setup.incoming && !setup.outgoing)) setup = await manualSettings(rl, setup);
    if (incomingOnly) {
      if (!setup.incoming) return usage();
      setup = { ...setup, outgoing: undefined };
    }
    if (!setup.incoming && !setup.outgoing) return usage();
    username = (await rl.question(`Login [${setup.email}]: `)).trim() || setup.email;
    const gmail = /@(gmail|googlemail)\.com$/i.test(setup.email) || setup.incoming?.host === "imap.gmail.com" || setup.outgoing?.host === "smtp.gmail.com";
    const gmailOAuth = gmail && Boolean(clientId && clientSecret)
      && (!setup.incoming || (setup.incoming.protocol === "imap" && setup.incoming.host.toLowerCase() === "imap.gmail.com"))
      && (gmailApi || !setup.outgoing || setup.outgoing.host?.toLowerCase() === "smtp.gmail.com");
    if (appPassword) {
      if (gmail) console.log("Use the app password created in your Google Account.");
    } else if (gmailOAuth) {
      oauth = Boolean(imported || port || gmailApi) || !/^(?:password|app|app password)$/i.test((await rl.question("Google sign-in or app password? [Google/app]: ")).trim());
    } else if (imported || port || gmailApi) {
      console.error("Google OAuth requires Gmail's IMAP or SMTP settings and a Desktop app OAuth client.");
      return 1;
    } else if (gmail) {
      console.log("Gmail app passwords require Google 2-Step Verification. Google sign-in for IMAP/SMTP is available with desktop OAuth credentials.");
    }
  } finally {
    rl.close();
  }

  let password: string;
  if (oauth) {
    console.log("Google requests mailbox access. ARGUS permissions start disabled and are enabled independently after setup.");
    if (gmailApi) console.log("Outgoing: Gmail API (HTTPS). Enable Gmail API in the same Google Cloud project before approving access.");
    try {
      password = await authorizeGmail({
        email: username, clientId, clientSecret, port, signal: AbortSignal.timeout(3 * 60_000),
        showUrl: (url) => console.log(`Open this URL privately in the browser on this host, or use the SSH loopback tunnel you set up:\n${url}`),
      });
    } catch {
      console.error("Google sign-in failed or expired. Check the desktop OAuth client configuration and try again.");
      return 1;
    }
  } else {
    stdin.pause();
    try {
      password = await readSecretLine("Mail password / app password (hidden): ");
    } finally {
      stdin.pause();
    }
    if (setup.incoming?.host === "imap.gmail.com" || setup.incoming?.host === "pop.gmail.com" || setup.outgoing?.host === "smtp.gmail.com") {
      password = password.replace(/ /g, "");
    }
  }
  if (!password) return 1;
  try {
    await mail.connect({ ...setup, outgoing: gmailApi ? { transport: "gmail-api" } : setup.outgoing,
      username, password, auth: oauth ? "gmail-oauth" : "password", gmailClient: imported });
  } catch (error) {
    if (!gmailApi) throw error;
    console.error("Gmail setup could not verify IMAP or the Gmail API. Check the selected account and enable Gmail API in the OAuth client's Google Cloud project.");
    return 1;
  }
  console.log("Mailbox connected. Open /mail in private Telegram to review and enable permissions. Terminal: `argus mail permissions <read|otp|send> on`.");
  return 0;
}

async function setupMicrosoftMail(
  mail: MailService,
  email: string | undefined,
  clientId: string,
  { incomingOnly, showSettings = true }: { incomingOnly: boolean; showSettings?: boolean },
): Promise<number> {
  try { clientId = microsoftOAuthClientId(clientId); }
  catch {
    console.error("Use the Application (client) ID of the Microsoft Entra public client.");
    return 1;
  }
  if (!email) {
    const rl = createInterface({ input: stdin, output: stdout });
    try { email = (await rl.question("Outlook.com mailbox address: ")).trim(); }
    finally { rl.close(); }
  }
  const address = mailAddress(email);
  const setup: MailSetup = { email: address, provider: "Outlook.com", source: "preset", graph: true,
    graphIncomingOnly: incomingOnly ? true : undefined,
  };
  if (showSettings) console.log(describeMailSetup(setup));
  const access = incomingOnly ? "verify this account and read mail" : "verify this account, read mail and send replies";
  console.log(`Microsoft requests access to ${access}. ARGUS permissions start disabled.`);
  try {
    const password = await authorizeMicrosoftMail({
      clientId,
      incomingOnly,
      signal: AbortSignal.timeout(15 * 60_000),
      showCode: (url, code) => console.log(`Open ${url} in your browser and enter this code privately: ${code}\nSign in as ${address} and review the consent request.`),
    });
    await mail.connect({ ...setup, password, auth: "microsoft-oauth", microsoftClientId: clientId });
  } catch {
    console.error("Outlook.com setup could not verify access. Check that the app supports personal Microsoft accounts, allows public client flows, and has the delegated Microsoft Graph permissions. Sign in with the selected mailbox.");
    return 1;
  }
  const permissions = incomingOnly ? "read|otp" : "read|otp|send";
  console.log(`Mailbox connected. Open /mail in private Telegram to review and enable permissions. Terminal: \`argus mail permissions <${permissions}> on\`.`);
  return 0;
}

export async function checkMailOtp(
  mail: Pick<MailService, "settings" | "readCode">,
  senderAddress: string,
  show: (message: string) => void,
  signal = AbortSignal.timeout(3 * 60_000),
): Promise<number> {
  const sender = mailAddress(senderAddress);
  const settings = mail.settings();
  const isCodesOnly = (current: ReturnType<MailService["settings"]>) => current && current.accountId === settings?.accountId
    && canReadMailCode(current) && current.permissions.otp && !current.permissions.read && !current.permissions.send;
  if (!settings || !isCodesOnly(settings)) {
    show("Use an IMAP or Outlook.com Microsoft Graph mailbox with read off, verification codes on, and send off before running this check.");
    return 1;
  }
  const reference = randomUUID().replaceAll("-", "");
  const subject = `ARGUS verification check ${reference}`;
  const syntheticCode = "314159";
  const notBefore = Date.now();
  show(`Send a new plain-text email from the selected test sender to the connected mailbox within three minutes.\nSubject: ${subject}\nBody: Verification code: ${syntheticCode}. Request ${reference}\nThe value above is a synthetic test code.`);
  try {
    while (!signal.aborted && isCodesOnly(mail.settings())) {
      const code = await mail.readCode({ accountId: settings.accountId, sender, subjectIncludes: subject, reference, notBefore, signal });
      if (code !== null) {
        if (isCodesOnly(mail.settings()) && code === syntheticCode) {
          show("PASS: codes-only check matched the synthetic message.");
          return 0;
        }
        break;
      }
      await delay(6000, undefined, { signal });
    }
  } catch { /* Reports a status without printing mail content or provider errors. */ }
  show("FAIL: codes-only check could not confirm the synthetic message. Check Inbox delivery, the sender, and the current permissions.");
  return 1;
}

async function manualSettings(rl: ReturnType<typeof createInterface>, setup: MailSetup): Promise<MailSetup> {
  const preferred = setup.incoming?.protocol ?? "imap";
  const protocol = (await rl.question(`Incoming protocol [imap/pop3/off] (${preferred}): `)).trim().toLowerCase() || preferred;
  if (protocol !== "imap" && protocol !== "pop3" && protocol !== "off") throw new Error("invalid incoming protocol");
  let incoming: MailSetup["incoming"];
  if (protocol !== "off") {
    const suggested = setup.incoming?.protocol === protocol ? setup.incoming.host : protocol === "pop3" && setup.incoming?.host === "imap.gmail.com" ? "pop.gmail.com" : "";
    const host = (await rl.question(`${protocol.toUpperCase()} TLS host${suggested ? ` [${suggested}]` : ""}: `)).trim() || suggested;
    incoming = { protocol, host, port: protocol === "imap" ? 993 : 995 };
  }
  const smtpDefault = setup.outgoing?.host ?? "";
  const smtpHost = (await rl.question(`SMTP host or 'off'${smtpDefault ? ` [${smtpDefault}]` : ""}: `)).trim() || smtpDefault;
  let outgoing: MailSetup["outgoing"];
  if (smtpHost && smtpHost.toLowerCase() !== "off") {
    const preferredPort = setup.outgoing?.port ?? 587;
    const port = Number((await rl.question(`SMTP port [465 TLS / 587 STARTTLS] (${preferredPort}): `)).trim() || preferredPort);
    if (port !== 465 && port !== 587) throw new Error("invalid SMTP port");
    outgoing = { host: smtpHost, port };
  }
  return { ...setup, incoming, outgoing, source: "manual" };
}

function state(enabled: boolean): string {
  return enabled ? "on" : "off";
}

function usage(): number {
  console.error("Usage: argus mail [status|discover <email>|setup [email] [--app-password|--gmail-client <file>] [--incoming-only] [--oauth-port <port>] [--gmail-send-api] [--microsoft-client-id <id>] [--force]|permissions <read|otp|send> <on|off>|check-read <sender> <subject>|check-otp <sender>|check-reply <sender> <subject>|disconnect --yes]");
  return 2;
}
