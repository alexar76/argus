# Buying a CoinMarketCap quote from Telegram

> **English** · [Русский](use-case-cmc-telegram-ru.md) · [Español](use-case-cmc-telegram-es.md) · [Français](use-case-cmc-telegram-fr.md) · [中文](use-case-cmc-telegram-zh.md)

On 13 November 2026, the owner approved one `cmc_buy_quotes` call for Bitcoin, CoinMarketCap ID `1`, in the private `@Argis3Bot` chat. The bot showed **$68,831.48** with a quote timestamp of **20:56:04 UTC** and returned the payment transaction hash. [CoinMarketCap x402 API](https://coinmarketcap.com/api/documentation/ai-agent-hub/x402)

## From approval to settlement

```mermaid
sequenceDiagram
    actor Owner as Owner in Telegram
    participant Bot as ARGUS
    participant CMC as CoinMarketCap x402
    participant Base as Base USDC contract
    participant Monitor as Alien Monitor
    Owner->>Bot: Request one USD quote for BTC (ID 1)
    Bot-->>Owner: Show cmc_buy_quotes with ID 1
    Owner->>Bot: Approve this action
    Bot->>CMC: GET latest quotes for ID 1
    CMC-->>Bot: HTTP 402 with Base payment terms
    Bot->>Bot: Validate the offer and sign one EIP-3009 authorization
    Bot->>CMC: Repeat GET with the signed authorization
    CMC->>Base: Settle through the x402 facilitator
    CMC-->>Bot: Return quote and payment receipt
    opt CMC receipt needs chain verification
        Bot->>Base: Verify the nonce and matching transfer
    end
    Bot->>Bot: Validate the USD quote
    Bot-)Monitor: Report success asynchronously
    Bot-->>Owner: Return USD price, quote time and Base hash
```

The approval button authorizes the exact tool arguments `{"ids":[1]}`. The first GET to `/x402/v3/cryptocurrency/quotes/latest?id=1` obtains a payment offer. ARGUS checks the resource, Base USDC contract, configured CMC recipient and **0.01 USDC** limit before signing one EIP-3009 authorization off chain. Funds move when the x402 facilitator submits the signed authorization to Base. ARGUS checks the payment response and can verify a CMC-specific receipt by matching the signed nonce and transfer on Base. If the outcome remains uncertain after submitting the authorization, ARGUS asks for reconciliation before a retry. [Tool configuration](personal-assistant.md#optional-paid-tools)

## How the run was verified

| Evidence | Result |
| --- | --- |
| Telegram | The owner requested and approved one call. ARGUS returned one BTC/USD quote and a Base transaction hash. |
| Base | The receipt recorded one `AuthorizationUsed` event, followed immediately by one `Transfer` of **10,000 USDC atoms (0.01 USDC)** from the dedicated wallet to the configured CMC recipient. The wallet balance fell from **0.01 to 0 USDC**. Three public RPC endpoints agreed on the canonical receipt in block **57,065,273**. PublicNode found one new wallet authorization from the preflight block **57,063,721**. The other two verified it by transaction hash after their log scans returned HTTP errors. [BaseScan transaction](https://basescan.org/tx/0x9ad76626d4ad1505363ecec1f4005e7840abdb516a3877fca39f736d81098ecc) |
| Alien Monitor | `coinmarketcap/argus/quotes` went from **0 to 1 success** with **0 failures**. The public endpoint shows 24-hour aggregates. The event has no transaction hash or nonce. The chain receipt independently proves the transfer. [Public counts](https://monitor.modelmarket.dev/api/provider-events) |

The block was awaiting finality during the first check. On 14 November 2026, all three Base RPCs confirmed finality for that block and transfer. [Finality check](../../artifacts/cmc-telegram-live-2026-11-13/finalized.json)

From the repository root, run this command with Node.js 22 or later and access to public Base RPC and Alien Monitor. It reads public evidence, including the current `finalized` block and rolling Monitor counts. The evidence files preserve the original before-and-after observation.

```sh
node artifacts/cmc-telegram-live-2026-11-13/check.mjs \
  0x9ad76626d4ad1505363ecec1f4005e7840abdb516a3877fca39f736d81098ecc
```

[Receipt verification](../../artifacts/cmc-telegram-live-2026-11-13/verified.json) · [Wallet authorization scan](../../artifacts/cmc-telegram-live-2026-11-13/authorization-window.json)

## The separate itch.io attempt

The ARGUS checkout had a receipt address configured and the refreshed Laso session verified **$5 available** with no itch.io debit. itch.io redirected the browser to its homepage before Stripe opened. The checkout sent no card payment and returned no receipt or ZIP. After a completed purchase in the owner's browser, `/recover_itch` can verify the receipt link and deliver the ZIP in Telegram without submitting another charge. [Laso pilot and checkout recovery](use-case-laso-prepaid-card.md#telegram-purchase-pilot) · [Checkout setup](personal-assistant.md#buy-the-itchio-icon-pack-from-telegram)
