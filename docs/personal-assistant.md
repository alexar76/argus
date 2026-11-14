# Mail, trip planning and purchases

Connect a mailbox with `argus mail setup`, then open `/mail` in your private owner chat. The inbox, verification codes and reply sending have separate permissions. The [mail setup guide](mail.md) covers Google OAuth for Gmail, Microsoft OAuth for Outlook.com, app passwords, IMAP, POP3 and SMTP.

## Planning and booking

ARGUS can prepare an official Resy restaurant link with the requested date and number of guests. Open the link, choose the slot and complete the booking in Resy. Resy manages its own sign-in and booking channels. [Resy security and approved integrations](https://resy.com/security-center)

For an authorized booking partner, configure these on the ARGUS host:

```sh
ARGUS_BOOKING_PARTNER_ORIGIN=https://your-booking-partner.example
ARGUS_BOOKING_PARTNER_TOKEN=<operator-provisioned-secret>
ARGUS_BOOKING_OTP_SENDER=booking@your-booking-partner.example
ARGUS_BOOKING_OTP_SUBJECT='Reservation confirmation code'
```

This adapter has a small HTTPS JSON contract. The partner should use an account already linked to the owner's booking email. Supply the sender directly from the partner's onboarding information. The user enables verification codes for a mailbox connected via IMAP or Microsoft Graph. A booking approval shows the partner, venue, local date and time, number of guests, maximum total and terms. ARGUS generates a fresh request reference, retrieves the matching code and passes it to the partner. The model receives the booking status and receipt fields.

| Endpoint | Contract |
| --- | --- |
| `POST /quote` | Receives `{venue, startsAt, guests, maximumCents}`. Returns `{id, venue, startsAt, guests, maximumCents, currency:"USD", terms, expiresAt}`. `maximumCents` covers the full possible charge and `terms` describes deposits, cancellation and no-show conditions. `startsAt` includes its UTC offset. |
| `GET /status?requestId=…` | Returns the previously recorded outcome for this request. Return 404 only when there is no confirmation or charge in progress. |
| `POST /challenge` | Receives `{offerId, reference, requestId}`. Sends a labeled six-digit code and the exact `reference` in the email, then returns `{id, reference}`. This step is free and places no booking. |
| `POST /confirm` | Receives `{offerId, challengeId, code, requestId, maximumCents}` and the same `Idempotency-Key` as `requestId`. The partner checks the amount and persists the result by key across restarts and transport failures. Returns `{requestId, status:"confirmed", bookingId, chargedCents, currency:"USD"}` or `{requestId, status:"declined", chargedCents:0}`. A pending or unknown outcome must be reconciled through `/status`. |

Run the local booking test with `npm test -- test/travel-booking.test.ts` from the `argus` directory. It uses a test booking partner and test inbox transport, with ARGUS's actual encrypted mailbox settings and code-selection logic. The fixture confirms one table for two at zero cost and returns the same booking when the request is repeated.

## Optional paid tools

Use a dedicated Base USDC wallet for these tools. Set `ARGUS_EXTERNAL_X402_WALLET_KEY` through the host's secret manager, and enable public crypto with `ARGUS_CRYPTO_ENABLED=1`. The tools run only in live mode and require a fresh approval of the displayed arguments. The client sends one signed request to the original HTTPS endpoint and reports the settlement transaction supplied by the provider. Check that transaction before retrying an ambiguous result.

| Tool | Configuration and scope |
| --- | --- |
| Tavily in METIS | `METIS_WEB_SEARCH_PROVIDER=tavily`. The keyless API is rate-limited. Set `METIS_TAVILY_API_KEY` for a Tavily account. [Tavily keyless API](https://docs.tavily.com/documentation/keyless) |
| `tavily_buy_search` in ARGUS | `ARGUS_TAVILY_X402_ENABLED=1`. Up to 0.01 USDC per search. The dedicated adapter accepts the current deposit address from Tavily's first-party HTTPS endpoint for that single quote. [Tavily x402](https://docs.tavily.com/documentation/machine-payments/x402) |
| `browserbase_buy_fetch`, `browserbase_buy_session`, `browserbase_delete_session` | `ARGUS_BROWSERBASE_ENABLED=1`. Set `ARGUS_BROWSERBASE_FETCH_HOSTS` to the exact allowed hosts for page fetch. The remote browser connection goes to the private owner channel. The paid adapter binds the rotating recipient to the original Browserbase challenge. [Browserbase payment gateway](https://x402.browserbase.com/) |
| `chuhching_buy_search` | Set `ARGUS_CHUHCHING_PAY_TO` to the seller-confirmed Base address. Searches creator, podcast or Steam curator directories with a 0.02 USDC ceiling. The 12 November 2026 preflight returned 1.00 USDC and a different resource origin, so the client refuses the current offer. [Chuhching agent tools](https://www.chuhching.com/agents) |
| `cmc_buy_quotes` | Set `ARGUS_CMC_PAY_TO` to the seller-confirmed Base address. Sends a direct paid GET for up to ten CoinMarketCap numeric IDs with a 0.01 USDC ceiling. [CoinMarketCap x402](https://coinmarketcap.com/api/documentation/ai-agent-hub/x402) |
| `laso_card_quote`, `laso_buy_card` | Set `ARGUS_LASO_MERCHANT` to one exact merchant name. ARGUS uses its dedicated external Base wallet for a free Laso sign-in and keeps the short-lived session in memory. `ARGUS_LASO_ID_TOKEN` can override wallet sign-in. `ARGUS_LASO_MAX_CENTS` defaults to 500. The tool checks merchant acceptance and previews the exact U.S. prepaid card load. Issuance requires owner approval and a private channel for the dashboard link. The owner completes checkout. [Laso wallet sign-in](https://docs.laso.finance/guides/authentication) · [Laso prepaid cards](https://docs.laso.finance/guides/usa-prepaid-card) |

The ModelMarket Hub retains its separate fixed-recipient policy. Tavily and Browserbase's request-specific deposit addresses are scoped to the two first-party adapters in ARGUS. The CMC test can run directly from the buyer's wallet. Public Hub registration requires seller consent and a configured recipient.

[CoinMarketCap quote bought from Telegram](use-case-cmc-telegram.md) · [Laso prepaid card pilot on Base](use-case-laso-prepaid-card.md) · [Bandcamp checkout check with Laso](use-case-laso-bandcamp.md)

## Buy the itch.io icon pack from Telegram

In a private chat with the pinned ARGUS bot, send `/buy_itch`, “buy the icons” or “купи иконки”. This pilot is bound to the **Co-Working & Startup Office Icon Pack** and its $2.99 base price. ARGUS shows the final USD total including tax and asks for one button confirmation. The ceiling is $5. [Product page](https://aiimperium.itch.io/co-working-startup-office-icon-pack)

ARGUS uses the configured receipt address or the connected mailbox address. If neither is available, it asks for an address in that chat. The address receives the merchant receipt. This flow can verify the paid page and download the ZIP without reading the mailbox. ARGUS uses the card's Laso billing data and asks for any missing fields. Card numbers and security codes should stay out of chat. If the merchant requires interactive verification or rejects the billing location, ARGUS stops and tells the owner what it needs.

On the authorized live bot host, opt in with these settings:

```sh
ARGUS_ITCH_PURCHASE_ENABLED=1
ARGUS_ITCH_BROWSER_WS_FILE=/run/checkout/browser-ws
ARGUS_ITCH_LASO_CARD_ID_FILE=/path/to/private-card-reference
ARGUS_ITCH_LASO_SESSION_FILE=/path/to/private-laso-session
# Optional. Defaults to the connected mailbox address or a private prompt.
ARGUS_ITCH_RECEIPT_EMAIL_FILE=/path/to/private-receipt-address
```

The session file contains a short-lived Laso ID token. The files must be owned by the ARGUS process with mode `0600`. A dedicated Laso-only signer file can be used instead with `ARGUS_ITCH_LASO_WALLET_KEY_FILE`. Give the checkout process access only to the authorized card's account. The bot needs an explicit owner ID. Use the isolated Chromium service for the live bot, or set `ARGUS_ITCH_CHROMIUM_PATH` for a local sandboxed Chromium instead. The browser receives card data only in the Stripe payment form. [Browser deployment](../deploy/checkout-browser/README.md)

ARGUS records the approved attempt before the merchant's charge request. If it has a receipt, it verifies the amount and ZIP and sends the file to the owner chat. It compares the charge and balance against Laso, which can report issuer updates asynchronously. If the outcome is unclear, repeat `/buy_itch` and use the delivery-only confirmation. ARGUS can ask for the private download link from the receipt to recover the ZIP without paying again. The checkout journal contains the charge amount and recovery state, with no card details, address or receipt link.

Attested runs the opt-in flow with a configured receipt address and isolated Chromium. The inbox is still disconnected. The live attempt reached itch.io's checkout redirect, which returned to the storefront before Stripe opened. The test did not charge the card or deliver a ZIP.

After a purchase in your own browser, send `/recover_itch` or “получи иконки” in the private bot chat. Confirm delivery and reply to the bot's prompt with the private link from the receipt. ARGUS checks the product, the paid total and the archive before sending the file. This command does not submit a payment. It can deliver the verified ZIP when the Laso session has expired, with debit reconciliation pending.

To exercise the checkout from the `argus` directory, set `ARGUS_TEST_CHROMIUM_PATH` to your local Chromium executable and run `npm test -- test/itch-browser.test.ts test/itch-purchase.test.ts test/telegram-purchase.test.ts test/icon-zip.test.ts`. The browser fixture supplies all merchant and Stripe responses locally.

## Hudson Link ticket from Telegram

The private command `/buy_hudson` is available when `ARGUS_HUDSON_PURCHASE_ENABLED=1` and a dedicated windowed checkout browser is configured. It handles one adult single ride from Palisades Center Lot J in West Nyack to Depot Plaza in Tarrytown at exactly USD 2.75. Hudson Link shows a validity period of 365 days. The bot asks for the traveler’s name and shows the exact trip and total before the owner approves. [Fares and single-ride ticket delivery](https://www.ridehudsonlink.com/fares)

The checkout uses the existing private Laso card and receipt address. The Laso directory currently lists Coach USA as `unknown`. A prior provider rejection stops the flow before payment. The bot records the attempt on disk before the order and blocks repeat charges after a lost response. It verifies the printable ticket, then reports the merchant receipt and the issuer debit separately if either is still pending. Hudson Link documents a separate email receipt. If the payment processor requests interactive verification, check the status before retrying. [Browser setup](../deploy/checkout-browser/README.md) · [Public preflight evidence](../../artifacts/argus-bus-preflight-2026-11-14/verified.json)
