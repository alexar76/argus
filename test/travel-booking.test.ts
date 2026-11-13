import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { MailService, type MailCodeCandidate, type MailTransport } from "../src/mail/index.js";
import { buildTravelBookingTools, resyBookingLink } from "../src/tools/travel-booking.js";

const log = createLogger("booking-test", "error");
const partner = "https://test-reservation.example";
const sender = "booking@reserver.example";
const code = "512907";

it("books through the partner fixture with approval and an isolated codes-only mailbox", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-booking-"));
  const candidates: MailCodeCandidate[] = [];
  const transport: MailTransport = {
    verify: vi.fn(), list: vi.fn(), read: vi.fn(), send: vi.fn(),
    codeCandidates: async () => candidates,
  };
  const mail = new MailService(dir, "test keystore passphrase", transport);
  const confirmations = new Map<string, { requestId: string; status: string; bookingId: string; chargedCents: number; currency: string }>();
  let challengeCount = 0;
  let confirmCount = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(partner);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    switch (url.pathname) {
      case "/quote":
        return Response.json({ ...body, id: "venue_slot_1", currency: "USD", terms: "No deposit or cancellation fee", expiresAt: new Date(Date.now() + 120_000).toISOString() });
      case "/status": {
        const outcome = confirmations.get(url.searchParams.get("requestId") ?? "");
        return outcome ? Response.json(outcome) : new Response(null, { status: 404 });
      }
      case "/challenge": {
        challengeCount += 1;
        expect(body.offerId).toBe("venue_slot_1");
        expect(body.reference).toMatch(/^[a-f0-9]{32}$/);
        const candidate = {
          id: "imap:1:10", from: sender, subject: "Reservation confirmation code", date: new Date().toISOString(),
          receivedAt: Date.now(), text: "Sensitive inbox text", codeText: `Your confirmation code is ${code}. Request ${body.reference}`,
        };
        candidates.push({ ...candidate, from: "unrelated@reserver.example", codeText: `Verification code: 999999 Request ${body.reference}` },
          { ...candidate, receivedAt: candidate.receivedAt - 60_000, codeText: `Verification code: 444444 Request ${body.reference}` },
          { ...candidate, codeText: "Verification code: 333333 Request unrelated78900000" }, candidate);
        return Response.json({ id: "challenge_1", reference: body.reference });
      }
      case "/confirm": {
        confirmCount += 1;
        expect(body).toMatchObject({ offerId: "venue_slot_1", challengeId: "challenge_1", code, maximumCents: 0 });
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(body.requestId);
        const outcome = { requestId: body.requestId, status: "confirmed", bookingId: "fixture-table-42", chargedCents: 0, currency: "USD" };
        confirmations.set(body.requestId, outcome);
        return Response.json(outcome);
      }
      default: throw new Error("unexpected endpoint");
    }
  });
  try {
    await mail.connect({ email: "booking@guest.example", incoming: { protocol: "imap", host: "imap.guest.example", port: 993 },
      provider: "fixture", source: "manual", password: "test-only-password" });
    const tools = buildTravelBookingTools({ origin: partner, token: "fixture-token", otpSender: sender, otpSubject: "reservation confirmation", mail, fetch });
    const quote = tools.find((tool) => tool.def.name === "travel_booking_quote")!;
    const book = tools.find((tool) => tool.def.name === "travel_book_approve")!;
    const args = { venue: "Test Restaurant", startsAt: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"), guests: 2, maximumCents: 0 };
    const offer = await quote.run(args, { log });
    const [, offerId, summary] = /^Offer ([a-f0-9-]+)\. Use this exact summary in travel_book_approve: (.+)$/.exec(offer.content)!;
    expect((await book.run({ offerId, summary }, { log })).ok).toBe(false);
    expect((await book.run({ offerId, summary }, { log, approved: true })).content).toContain("codes-only access");
    expect(challengeCount).toBe(0);
    mail.setPermissions({ otp: true });
    await expect(mail.list()).rejects.toThrow("read permission is disabled");
    expect((await book.run({ offerId, summary: `${summary} changed` }, { log, approved: true })).ok).toBe(false);
    const outcome = await book.run({ offerId, summary }, { log, approved: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain("fixture-table-42");
    expect(outcome.content).toContain("Charged USD 0.00");
    expect(JSON.stringify(outcome)).not.toMatch(new RegExp(`${code}|Sensitive inbox|fixture-token`));
    expect((await book.run({ offerId, summary }, { log, approved: true })).ok).toBe(false);
    const repeated = await quote.run(args, { log });
    const nextId = repeated.content.match(/^Offer ([a-f0-9-]+)\./)![1];
    expect((await book.run({ offerId: nextId, summary }, { log, approved: true })).ok).toBe(true);
    expect(challengeCount).toBe(1);
    expect(confirmCount).toBe(1);
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("builds an official Resy handoff and rejects invalid days and lookalike domains", () => {
  const venue = "https://resy.com/cities/ny/venues/sample?other=foo";
  expect(resyBookingLink(venue, "2027-05-20", 2)).toBe("https://resy.com/cities/ny/venues/sample?date=2027-05-20&seats=2");
  expect(() => resyBookingLink(venue, "2027-02-30", 2)).toThrow();
  expect(() => resyBookingLink(venue.replace("resy.com", "resy.com.other.example"), "2027-05-20", 2)).toThrow();
});
