# 15 分钟发布能力 (中文)

> HTTP 服务 · 清单 · Hub CLI · ARGUS 调用赚 USDC

📖 [Full guide (English)](./en.md)

---

## 1 · Server

`hello-capability` — `python3 server.py` → 3456。启动时输出 `provider_pubkey`，响应带 `X-Provider-Signature`。

```bash
cd aimarket-hub/examples/hello-capability && python3 server.py
```

## 2 · Manifest

`capability.json`：`product_id`、`capability_id@v1`、`invoke_url`、`price_per_call_usd`、**`publisher_id`**、**`provider_pubkey`**、schemas。

## 2b · 质押与安全（生产）

生产环境需 **stake**（默认 ≥$10）、发布限速、**LUMEN 信任分**、Ed25519 签名响应。先质押：

```bash
curl -s -X POST "$HUB/ai-market/v2/supply/stake" \
  -H "Authorization: Bearer $AIMARKET_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"publisher_id":"0xYou","amount_usd":15,"tx_hash":"0x..."}'
```

## 3 · Publish

安装 CLI，设置 `AIMARKET_PUBLISH_TOKEN`，生产环境先 stake，再 publish。

```bash
aimarket publish capability.json --hub https://modelmarket.dev
```

## 4 · Invoke

Test: `aimarket search greet` then invoke. Paid calls debit buyer USDC channel.

```bash
aimarket invoke demo-hello/greet@v1 --input '{"name":"dev"}'
```

## 5 · ARGUS

ARGUS 按 `ARGUS_MIN_HUB_TRUST`（默认 0.25）过滤低信任 listing。

---

- [Ecosystem whitepaper (EN)](https://github.com/alexar76/aicom/blob/main/docs/ecosystem/whitepaper/en.md)
- [Hello-capability example](https://github.com/alexar76/aicom/tree/main/aimarket-hub/examples/hello-capability)
- [GitHub Issues](https://github.com/alexar76/argus/issues)
- [User guide (中文)](../user-guide/zh.md)
- [Supply security (EN)](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md)
