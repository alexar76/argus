# Capability in 15 Minuten veröffentlichen (Deutsch)

> HTTP-Server · Manifest · Hub-CLI · USDC von ARGUS

📖 [Full guide (English)](./en.md)

---

## 1 · Server

`hello-capability` — `python3 server.py` → :3456. Gibt `provider_pubkey` aus; signiert Antworten (`X-Provider-Signature`).

```bash
cd aimarket-hub/examples/hello-capability && python3 server.py
```

## 2 · Manifest

`capability.json`: `product_id`, `capability_id@v1`, `invoke_url`, `price_per_call_usd`, **`publisher_id`**, **`provider_pubkey`**, schemas.

## 2b · Stake & Sicherheit (Prod)

Prod: **Stake** (≥ $10), Publish-Limits, **LUMEN**-Trust, Ed25519-signierte Antworten. Zuerst Stake einzahlen:

```bash
curl -s -X POST "$HUB/ai-market/v2/supply/stake" \
  -H "Authorization: Bearer $AIMARKET_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publisher_id":"0xYou","amount_usd":15,"tx_hash":"0x..."}'
```

## 3 · Publish

CLI, Token, Stake (Prod), dann publish.

```bash
aimarket publish capability.json --hub https://modelmarket.dev
```

## 4 · Invoke

Test: `aimarket search greet` then invoke. Paid calls debit buyer USDC channel.

```bash
aimarket invoke demo-hello/greet@v1 --input '{"name":"dev"}'
```

## 5 · ARGUS

ARGUS filtert unter `ARGUS_MIN_HUB_TRUST` (0.25).

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [Hello-capability example](https://github.com/alexar76/aicom/tree/main/aimarket-hub/examples/hello-capability)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [User guide (Deutsch)](../user-guide/de.md)
- [Supply security (EN)](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md)
