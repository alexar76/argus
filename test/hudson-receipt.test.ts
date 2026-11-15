import { describe, expect, it } from "vitest";
import { hudsonOrderFromTicketUrl, hudsonReceiptMatches } from "../src/checkout/hudson-receipt.js";

const orderId = "fixtureOrder123";
const receipt = `Order Number: ${orderId}
Order Status: Captured
Origin WEST NYACK, NY
Destination TARRYTOWN, NY
Issuing OPR HUDSON LINK
ONE-WAY, ADULT 1 $2.75
Order Total $2.75
Payment Method (Visa X1111) $2.75
AMOUNT PAID $2.75`;

describe("Hudson Link receipt reconciliation", () => {
  it("requires the exact captured order, route, total, paid amount and card", () => {
    expect(hudsonReceiptMatches(receipt, orderId, "1111")).toBe(true);
    for (const [value, replacement] of [["Captured", "Authorized"], ["AMOUNT PAID $2.75", "AMOUNT PAID $2.74"],
      ["Order Total $2.75", "Order Total $5.50"], ["TARRYTOWN", "WHITE PLAINS"], ["X1111", "X2222"],
      ["ADULT 1", "ADULT 2"], ["Order Total $2.75", "Order Total $2.75\nOrder Total $5.50"]]) {
      expect(hudsonReceiptMatches(receipt.replace(value!, replacement!), orderId, "1111")).toBe(false);
    }
    expect(hudsonReceiptMatches(receipt, "fixtureOrder222", "1111")).toBe(false);
  });

  it("extracts an order only from the official ticket URL", () => {
    const link = `https://www.ridehudsonlink.com/tickets?order_id=${orderId}`;
    expect(hudsonOrderFromTicketUrl(link)).toBe(orderId);
    expect(hudsonOrderFromTicketUrl(link.replace("www.ridehudsonlink.com", "ridehudsonlink.com.evil.test"))).toBeUndefined();
    expect(hudsonOrderFromTicketUrl(link + "&order_id=fixtureOrder999")).toBeUndefined();
    expect(hudsonOrderFromTicketUrl(link.replace(orderId, "%2E%2E%2Fother"))).toBeUndefined();
  });
});
