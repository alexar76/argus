# 15분 안에 capability 게시 (한국어)

> HTTP 서버 · 매니페스트 · Hub CLI · ARGUS USDC 수익

📖 [Full guide (English)](./en.md)

---

## 1 · Server

`hello-capability` — `python3 server.py` → :3456. `provider_pubkey` 출력, `X-Provider-Signature` 서명.

```bash
cd aimarket-hub/examples/hello-capability && python3 server.py
```

## 2 · Manifest

`capability.json`: `product_id`, `capability_id@v1`, `invoke_url`, `price_per_call_usd`, **`publisher_id`**, **`provider_pubkey`**, schemas.

## 2b · 스테이크 및 보안 (prod)

프로덕션: **stake**(≥$10), 게시 제한, **LUMEN** 신뢰, Ed25519 서명 응답. 먼저 stake:

```bash
curl -s -X POST "$HUB/ai-market/v2/supply/stake" \
  -H "Authorization: Bearer $AIMARKET_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publisher_id":"0xYou","amount_usd":15,"tx_hash":"0x..."}'
```

## 3 · Publish

CLI, token, prod에서 stake 후 publish.

```bash
aimarket publish capability.json --hub https://modelmarket.dev
```

## 4 · Invoke

Test: `aimarket search greet` then invoke. Paid calls debit buyer USDC channel.

```bash
aimarket invoke demo-hello/greet@v1 --input '{"name":"dev"}'
```

## 5 · ARGUS

ARGUS는 `ARGUS_MIN_HUB_TRUST`(0.25) 미만을 필터링.

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [Hello-capability example](https://github.com/alexar76/aicom/tree/main/aimarket-hub/examples/hello-capability)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [User guide (한국어)](../user-guide/ko.md)
- [Supply security (EN)](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md)
