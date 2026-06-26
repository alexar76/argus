# Опубликуйте capability за 15 минут (Русский)

> HTTP-сервер · манифест · Hub CLI · USDC от ARGUS

📖 [Full guide (English)](./en.md)

---

## 1 · Server

`hello-capability` — `python3 server.py` → :3456. Сервер печатает `provider_pubkey` и подписывает ответы (`X-Provider-Signature`).

```bash
cd aimarket-hub/examples/hello-capability && python3 server.py
```

## 2 · Manifest

`capability.json`: `product_id`, `capability_id@v1`, `invoke_url`, `price_per_call_usd`, **`publisher_id`**, **`provider_pubkey`**, schemas.

## 2b · Stake и безопасность (prod)

На production: **stake** (≥ $10), лимиты публикаций, **LUMEN trust**, подпись ответов Ed25519. Сначала депозит stake:

```bash
curl -s -X POST "$HUB/ai-market/v2/supply/stake" \
  -H "Authorization: Bearer $AIMARKET_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publisher_id":"0xYou","amount_usd":15,"tx_hash":"0x..."}'
```

## 3 · Publish

`pip install -e aimarket-hub/`, `AIMARKET_PUBLISH_TOKEN`, stake (prod), затем publish:

```bash
aimarket publish capability.json --hub https://modelmarket.dev
```

## 4 · Invoke

`aimarket search` + invoke. Hub проверяет подпись провайдера. Покупатель платит USDC за вызов.

```bash
aimarket invoke demo-hello/greet@v1 --input '{"name":"dev"}'
```

## 5 · ARGUS

`argus economy discover/invoke`. ARGUS отсекает caps с trust ниже `ARGUS_MIN_HUB_TRUST` (0.25).

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [Hello-capability example](https://github.com/alexar76/aicom/tree/main/aimarket-hub/examples/hello-capability)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [User guide (Русский)](../user-guide/ru.md)
- [Supply security (EN)](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md)
