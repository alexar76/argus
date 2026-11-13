import { lookup, Resolver } from "node:dns/promises";
import { isNonPublicAddress } from "../tools/public-address.js";
import { mailAddress, mailHost, type MailSetup } from "./types.js";

const presets = [
  { domains: ["gmail.com", "googlemail.com"], provider: "Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 465 },
  { domains: ["yahoo.com", "ymail.com", "rocketmail.com"], provider: "Yahoo Mail", imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465 },
  { domains: ["icloud.com", "me.com", "mac.com"], provider: "iCloud Mail", imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  { domains: ["fastmail.com", "fastmail.fm"], provider: "Fastmail", imap: "imap.fastmail.com", smtp: "smtp.fastmail.com", smtpPort: 465 },
];

export async function pinMailServer(host: string): Promise<string> {
  const addresses = await lookup(mailHost(host), { all: true, verbatim: false });
  const address = addresses[0]?.address;
  if (!address || addresses.some(record => isNonPublicAddress(record.address))) {
    throw new Error("Mail server did not resolve exclusively to public addresses.");
  }
  return address;
}

const resolver = new Resolver({ timeout: 1_000, tries: 2 });

async function srvHost(service: string, domain: string, port: number): Promise<string | undefined> {
  try {
    const records = await resolver.resolveSrv(`${service}._tcp.${domain}`);
    const record = records.filter(item => item.port === port && item.name !== ".")
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (!record) return undefined;
    const host = mailHost(record.name);
    // Cross-domain credentials must be configured explicitly. Untrusted DNS discovery cannot choose their recipient.
    return host === domain || host.endsWith(`.${domain}`) ? host : undefined;
  } catch {
    return undefined;
  }
}

async function publicGuess(candidates: string[]): Promise<string | undefined> {
  const checks = await Promise.allSettled(candidates.map(pinMailServer));
  return candidates[checks.findIndex(result => result.status === "fulfilled")];
}

/** Look up only the domain. Discovered endpoints are suggestions until the owner confirms them. */
export async function discoverMail(address: string): Promise<MailSetup> {
  const email = mailAddress(address);
  const domain = email.split("@")[1]!;
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) {
    return { email, provider: "Outlook.com", source: "preset", graph: true };
  }
  const preset = presets.find(item => item.domains.includes(domain));
  if (preset) {
    return {
      email, provider: preset.provider, source: "preset",
      incoming: { protocol: "imap", host: preset.imap, port: 993 },
      outgoing: { host: preset.smtp, port: preset.smtpPort },
    };
  }

  const [imaps, pop3s, submissions, submission] = await Promise.all([
    srvHost("_imaps", domain, 993), srvHost("_pop3s", domain, 995),
    srvHost("_submissions", domain, 465), srvHost("_submission", domain, 587),
  ]);
  const [imapGuess, smtpGuess] = await Promise.all([
    imaps || pop3s ? undefined : publicGuess([`imap.${domain}`, `mail.${domain}`]),
    submissions || submission ? undefined : publicGuess([`smtp.${domain}`, `mail.${domain}`]),
  ]);
  const imap = imaps ?? imapGuess;
  const smtp = submissions ?? submission ?? smtpGuess;
  return {
    email, provider: domain, source: imap || pop3s || smtp ? "dns" : "manual",
    incoming: imap ? { protocol: "imap", host: imap, port: 993 } :
      pop3s ? { protocol: "pop3", host: pop3s, port: 995 } : undefined,
    outgoing: smtp ? { host: smtp, port: submissions ? 465 : 587 } : undefined,
  };
}
