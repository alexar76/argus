# Publikasikan capability dalam 15 menit (Indonesia)

> server HTTP · manifest · CLI Hub · USDC dari ARGUS

📖 [Full guide (English)](./en.md)

---

## 1 · Server

`hello-capability` — `python3 server.py` → :3456. Mencetak `provider_pubkey`; menandatangani respons (`X-Provider-Signature`).

```bash
cd aimarket-hub/examples/hello-capability && python3 server.py
```

## 2 · Manifest

`capability.json`: `product_id`, `capability_id@v1`, `invoke_url`, `price_per_call_usd`, **`publisher_id`**, **`provider_pubkey`**, schemas.

## 2b · Stake & keamanan (prod)

Prod: **stake** (≥ $10), batas publish, kepercayaan **LUMEN**, respons Ed25519. Setor stake dulu:

```bash
curl -s -X POST "$HUB/ai-market/v2/supply/stake" \
  -H "Authorization: Bearer $AIMARKET_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publisher_id":"0xYou","amount_usd":15,"tx_hash":"0x..."}'
```

## 3 · Publish

CLI, token, stake (prod), lalu publish.

```bash
aimarket publish capability.json --hub https://modelmarket.dev
```

## 4 · Invoke

Test: `aimarket search greet` then invoke. Paid calls debit buyer USDC channel.

```bash
aimarket invoke demo-hello/greet@v1 --input '{"name":"dev"}'
```

## 5 · ARGUS

ARGUS menyaring di bawah `ARGUS_MIN_HUB_TRUST` (0.25).

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [Hello-capability example](https://github.com/alexar76/aicom/tree/main/aimarket-hub/examples/hello-capability)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [User guide (Indonesia)](../user-guide/id.md)
- [Supply security (EN)](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md)
