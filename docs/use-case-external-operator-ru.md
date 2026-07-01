# Use case — свой ARGUS в экосистеме AICOM

> **Для кого:** операторы, которые поднимают **свой** инстанс ARGUS (VPS, ноутбук,
> корпоративный контур) и хотят **покупать или продавать** в публичной экономике AICOM —
> без форка протокола и без «белого списка».
>
> EN: [use-case-external-operator.md](./use-case-external-operator.md) ·
> [economy-integration.md](./economy-integration.md) ·
> [Onboard a new node](../../docs/onboard-a-node.md)

---

## Сценарий

**Алиса** запускает ARGUS на своём сервере. Factory, Hub и оракулы ей не принадлежат,
но агент должен:

- находить и **оплачивать** capabilities (оракулы, lottery, сторонние API),
- при желании **регистрироваться и продавать** свои capabilities,
- держать **WARDEN** для любых подключённых MCP-серверов,

…через **тот же AIMarket Protocol v2**, что и эталон на
[magic-ai-factory.com](https://magic-ai-factory.com).

**Whitelist не нужен.** Подключение = конфигурация + протокол + правила Hub (stake,
trust, подписи для поставщиков).

> **Alien Monitor:** отдельный «шарик» на каждый чужой ARGUS **не появится** — в графе
> один якорный узел `argus`. В Hub/Mesh участник полноценный.

---

## Три режима участия

| Режим | Кошелёк | Что даёт |
|-------|---------|----------|
| **Локальный автономный** | Нет | WARDEN, MCP, модели, память — без Hub |
| **Потребитель** | Да + crypto ON | discover → channel → invoke → settle (USDC) |
| **Потребитель + поставщик** | Да + crypto ON | + register + listing → заработок |

Экономика включается **только** при наличии ключа кошелька. См. [autonomy.md](./autonomy.md).

---

## Что настраивать

### Всегда

| Параметр | Где | Зачем |
|----------|-----|-------|
| Конфиг | `argus.config.json` | Модели, WARDEN, MCP, лимиты бюджета |
| Секреты | `.env` | API-ключи LLM; **не** класть wallet key в json |
| HTTP | `ARGUS_HTTP_PORT` (8787) | `/health`, `/ask`, Arena |

### Потребитель (покупает у экосистемы)

| Параметр | По умолчанию | Переопределение |
|----------|--------------|-----------------|
| Кошелёk | — | `ARGUS_WALLET_KEY` или keystore |
| Crypto | **OFF** | `AIFACTORY_CRYPTO_ENABLED=1` |
| Hub | `https://magic-ai-factory.com` | `ARGUS_HUB_URL` |
| Oracle family | `https://oracles.modelmarket.dev/family` | `ARGUS_ORACLE_FAMILY_URL` |
| Mesh | `http://127.0.0.1:8090` | `ARGUS_MESH_URL` |
| Сеть / токен | Base / USDC | `economy.chain`, `economy.token` |
| Мин. trust | `0.25` | `ARGUS_MIN_HUB_TRUST` |
| Депозит канала | `$1` | `economy.defaultDepositUsd` |

### Поставщик (продаёт в экосystem)

То же +:

```bash
argus economy register
argus serve    # или argus mcp
```

На production Hub: **stake**, **Ed25519-подпись ответов**, **LUMEN trust** —
[supply-security](https://github.com/alexar76/aimarket-hub/blob/main/docs/supply-security.md).

### Корпоративный контур без публичного chain

**UNI mode** — те же API, приватный Anvil + внутренние кредиты.
[uni-corporate-usecase.md](../../docs/uni-corporate-usecase.md).

---

## Минимальный старт (потребитель, ~15 мин)

```bash
curl -fsSL https://magic-ai-factory.com/install | bash

export ARGUS_WALLET_KEY="0x…"       # USDC на Base
export AIFACTORY_CRYPTO_ENABLED=1
export ARGUS_HUB_URL="https://magic-ai-factory.com"

argus doctor
argus economy discover "randomness vdf" --budget 0.05
argus economy invoke prod-chronos chronos.eval@v1 \
  --input '{"seed":"alice-1","difficulty":500}'
```

---

## Минимальный старт (поставщик)

[Developer guide](./developer-guide/ru.md) → capability на Hub, затем:

```bash
export ARGUS_WALLET_KEY="0x…"
export AIFACTORY_CRYPTO_ENABLED=1
argus economy register
argus serve
```

Другие ARGUS и любые клиенты `@aimarket/agent` найдут listing через Hub.

---

## Что экосистема проверяет сама (не «закрывает», а защищает)

| Проверка | Кому |
|----------|------|
| Manifest v2 + подписанные receipts | Все invoke |
| Payment channel / escrow | Платные вызовы |
| Stake + подпись ответа | Сторонний supply на prod Hub |
| LUMEN trust_score | Ранжирование и лимиты |
| WARDEN | Сторонний MCP **на вашем** ARGUS |

---

## Troubleshooting

| Симптом | Решение |
|---------|---------|
| `economy: OFF` | `ARGUS_WALLET_KEY` |
| `402 Payment Required` | Пополнить USDC channel |
| Пустой discover | Ключевые слова intent; `ARGUS_MIN_HUB_TRUST`; URL Hub |
| `minimum stake` | Stake на Hub, затем republish |
| `POST /ask` не платит | Использовать `argus economy invoke` |

---

## Связанные документы

- [economy-integration.md](./economy-integration.md) — диаграммы SDK
- [mcp-oracles-capabilities.md](./mcp-oracles-capabilities.md) — 17 оракулов
- [Onboard a new node](../../docs/onboard-a-node.md) — свой HTTP-сервис как узел (не ARGUS)
