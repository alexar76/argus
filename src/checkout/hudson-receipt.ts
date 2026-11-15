import { createHash } from "node:crypto";
import { readProviderJson } from "../economy/external-payment.js";
import { hudsonTicketReference } from "./hudson-browser.js";

const api = "https://api.prod.coachusa.com";
const web = "https://www.ridehudsonlink.com";
const allowedTicketHosts = new Set(["ridehudsonlink.com", "www.ridehudsonlink.com"]);
const maxPdfBytes = 2 * 1024 * 1024;
export const HUDSON_ORDER_ID = /^[a-zA-Z0-9_-]{8,120}$/;

export function hudsonOrderFromTicketUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const [parameter] = url.searchParams;
    if (url.protocol !== "https:" || !allowedTicketHosts.has(url.hostname) || url.port || url.username || url.password
      || url.hash || url.pathname !== "/tickets" || url.searchParams.size !== 1 || parameter?.[0] !== "order_id") return;
    if (HUDSON_ORDER_ID.test(parameter[1])) return parameter[1];
  } catch { /* Invalid URL. */ }
}

async function readPdf(response: Response): Promise<Buffer> {
  if (!response.body || !/^(?:application\/pdf|application\/octet-stream)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    throw new Error("Unexpected Hudson Link receipt content type");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPdfBytes) { await reader.cancel(); throw new Error("Hudson Link receipt exceeds the size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !/%%EOF\s*$/.test(bytes.subarray(-64).toString("ascii"))) {
    throw new Error("Invalid Hudson Link receipt PDF");
  }
  return bytes;
}

async function receiptLines(pdf: Buffer, signal: AbortSignal): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  signal.throwIfAborted();
  const task = getDocument({ data: Uint8Array.from(pdf), stopAtErrors: true, useSystemFonts: false,
    disableFontFace: true, useWasm: false, useWorkerFetch: false, enableXfa: false });
  const stop = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const doc = await task.promise;
    if (doc.numPages !== 1) throw new Error("Unexpected Hudson Link receipt page count");
    const page = await doc.getPage(1);
    const { items } = await page.getTextContent();
    const lines = new Map<number, { x: number; value: string }[]>();
    for (const item of items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const x = item.transform[4]!;
      const y = Math.round(item.transform[5]! / 3) * 3;
      const line = lines.get(y) ?? [];
      line.push({ x, value: item.str });
      lines.set(y, line);
    }
    const rows = [...lines.entries()].sort(([a], [b]) => b - a);
    const label = rows.find(([_, line]) => line.some(item => /^Payment Method\s*\(Visa/i.test(item.value)));
    if (label) {
      // This receipt wraps the masked card number and places the payment amount between the two baselines.
      const [top, payment] = label;
      for (const [y, line] of rows) {
        if (y < top && top - y <= 12) {
          payment.push(...line);
          line.length = 0;
        }
      }
    }
    return rows.map(([_, line]) => line.sort((a, b) => a.x - b.x).map(item => item.value).join(" ")
      .replace(/\s+/g, " ").trim()).join("\n");
  } finally {
    signal.removeEventListener("abort", stop);
    await task.destroy().catch(() => {});
  }
}

export function hudsonReceiptMatches(lines: string, orderId: string, last4: string): boolean {
  const field = (pattern: RegExp, expected: string) => {
    const values = [...lines.matchAll(pattern)];
    return values.length === 1 && values[0]?.[1] === expected;
  };
  return field(/^Order (?:Number|ID)\s*:\s*([A-Za-z0-9_-]+)$/gim, orderId)
    && field(/^Order Status\s*:\s*(\w+)$/gim, "Captured")
    && field(/^Order Total\s+\$([\d.]+)$/gim, "2.75")
    && field(/^Amount Paid\s+\$([\d.]+)$/gim, "2.75")
    && field(/^Payment Method[ \t]*\(Visa\s+[X*• \t]*(\d{4})\)\s+\$2\.75$/gim, last4)
    && /^Origin\s+West Nyack, NY$/im.test(lines)
    && /^Destination\s+Tarrytown, NY$/im.test(lines)
    && /^Issuing OPR\s+Hudson Link$/im.test(lines)
    && /^ONE-WAY,\s+ADULT\s+1\s+\$2\.75$/im.test(lines);
}

export async function verifyHudsonReceipt(input: {
  orderId: string;
  last4: string;
  ticketReference?: string;
  signal: AbortSignal;
}): Promise<string> {
  const { orderId, last4, ticketReference } = input;
  if (!HUDSON_ORDER_ID.test(orderId) || !/^\d{4}$/.test(last4)) throw new Error("Missing Hudson Link order or card reference");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  const get = async (suffix: string, accept: string) => {
    const response = await fetch(`${api}/order/${orderId}${suffix}`, {
      method: "GET", redirect: "error", signal, headers: { accept, origin: web, referer: `${web}/` },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Hudson Link lookup returned HTTP ${response.status}`); }
    return response;
  };
  const order = await readProviderJson(await get("", "application/json"), 500_000);
  const reference = hudsonTicketReference(order, false);
  if (!reference || (ticketReference && reference !== ticketReference)) throw new Error("Hudson Link ticket does not match");
  const bytes = await readPdf(await get("/receipt", "application/pdf, application/octet-stream"));
  if (!hudsonReceiptMatches(await receiptLines(bytes, signal), orderId, last4)) throw new Error("Hudson Link receipt does not match");
  return createHash("sha256").update(bytes).digest("hex");
}
