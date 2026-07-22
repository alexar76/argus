# 15分で capability を公開 (日本語)

> HTTP サーバー · マニフェスト · Hub CLI · ARGUS から USDC

📖 [Full guide (English)](./en.md)

---

## 1 · Server

`hello-capability` — `python3 server.py` → :3456。起動時に `provider_pubkey` を表示し、`X-Provider-Signature` で署名。

```bash
cd aimarket-hub/examples/hello-capability && python3 server.py
```

## 2 · Manifest

`capability.json`: `product_id`, `capability_id@v1`, `invoke_url`, `price_per_call_usd`, **`publisher_id`**, **`provider_pubkey`**, schemas.

## 2b · ステークとセキュリティ（本番）

本番: **stake**（≥$10）、公開レート制限、**LUMEN** 信頼、Ed25519 署名応答。先に stake:

```bash
curl -s -X POST "$HUB/ai-market/v2/supply/stake" \
  -H "Authorization: Bearer $AIMARKET_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publisher_id":"0xYou","amount_usd":15,"tx_hash":"0x..."}'
```

## 3 · Publish

CLI 導入、token、本番では stake 後に publish。

```bash
aimarket publish capability.json --hub https://modelmarket.dev
```

## 4 · Invoke

Test: `aimarket search greet` then invoke. Paid calls debit buyer USDC channel.

```bash
aimarket invoke demo-hello/greet@v1 --input '{"name":"dev"}'
```

## 5 · ARGUS

ARGUS は `ARGUS_MIN_HUB_TRUST`（0.25）未満を除外。

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [Hello-capability example](https://github.com/alexar76/aicom/tree/main/aimarket-hub/examples/hello-capability)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [User guide (日本語)](../user-guide/ja.md)
- [Supply security (EN)](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md)
