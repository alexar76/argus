import { describe, expect, it } from "vitest";
import { createLasoCheckoutCard } from "../src/checkout/laso-card.js";

const cardId = "O-fixtureCard01";

function readCard(transactions: unknown[]) {
  const card = createLasoCheckoutCard({
    id: cardId,
    token: async () => "fixture",
    request: async () => Response.json({
      card_id: cardId, status: "ready", country: "US", usd_amount: 5,
      card_details: { available_balance: 2.25 }, transactions,
    }),
  });
  return card.read(new AbortController().signal);
}

describe("Laso checkout activity", () => {
  it("recognizes exact signed string and numeric amounts for the correct merchant", async () => {
    const state = await readCard([
      { amount: "-002.7500", description: "Coach USA", is_credit: false },
      { amount: "+2.75", description: "HUDSON LINK", is_credit: true },
      { amount: "2.75", description: "Unrelated merchant", is_credit: false },
      { amount: "0.1", description: "Hudson Link", is_credit: false },
      { amount: "1", description: "Hudson Link", is_credit: false },
      { amount: -2.99, description: "ITCH.IO", is_credit: false },
      { amount: "+2.99", description: "itch.io", is_credit: false },
    ]);
    expect(state).toMatchObject({ balanceCents: 225, hudsonDebits: [275, 10, 100], itchDebits: [299, 299] });
  });

  it("rejects malformed, fractional-cent and unsafe amounts without rounding", async () => {
    const malformed = ["2.751", "2.75001", 2.7500000001, "2.75e0", " 2.75", "2.75\n", "$2.75", "-2,75", "2.75 usd", "90071992547409.92", "", null];
    const state = await readCard(malformed.map(amount => ({ amount, description: "Hudson Link", is_credit: false })));
    expect(state.hudsonDebits).toEqual([]);
  });
});
