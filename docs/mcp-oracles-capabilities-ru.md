# MCP, oracles и capabilities

> 🌐 Язык: [English](./mcp-oracles-capabilities.md) · **Русский** · [Español](./mcp-oracles-capabilities-es.md)

> Часть набора документации ARGUS (`argus/docs/`):
> [architecture](./architecture.md) · [security-warden](./security-warden.md) · [economy-integration](./economy-integration.md) · [channels](./channels.md) · **mcp-oracles-capabilities**

ARGUS экспонирует **три разных «tool»-поверхности**. Их легко перепутать — эта страница карта.

| Поверхность | Направление | WARDEN? | Wallet? |
|-------------|-------------|---------|---------|
| **Native ecosystem tools** | ARGUS → AICOM (oracles, hub, lottery, ACEX) | **No** — first-party, trusted | Oracles: **no**. Paid hub / lottery / ACEX: **yes** |
| **Third-party MCP servers** | ARGUS → external MCP (filesystem, browser, …) | **Yes** — full gate chain | Зависит от инструмента |
| **ARGUS as MCP server** | Other agents / IDEs → ARGUS | N/A (вы — сервер) | Покупатели платят **вам** при листинге на Hub |

Подробнее: [security-warden.md](./security-warden.md) · [economy-integration.md](./economy-integration.md) · [channels.md](./channels.md) · [oracles/docs/en.md](https://github.com/alexar76/oracles/blob/main/docs/en.md)

---

## 1 · Сторонний MCP (входящий в ARGUS)

Настраивается в `mcp.servers` и опционально `mcp.catalogs` в `argus.config.json`. Каждый сервер проходит **WARDEN** перед тем, как любое определение инструмента попадёт в модель:

**static-scan → threat-feed → LUMEN reputation → pinning → sensitive-tool approval**

```bash
argus warden scan      # verdict per configured server
argus doctor           # count of servers + catalogs
```

Пример конфига:

```json
"mcp": {
  "catalogs": ["https://example.com/mcp-catalog.json"],
  "servers": [
    {
      "id": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  ]
}
```

### Внешний MCP: aimarket-oracle-gateway

Можно также подключить MCP-сервер **[aimarket-oracle-gateway](https://github.com/alexar76/aimarket-oracle-gateway)** (stdio), чтобы Cursor / Claude Desktop получали инструменты Platon / Chronos / LUMEN (`get_random`, `compute_vdf`, `verify_vdf`, `get_reputation_scores`, …). С точки зрения ARGUS этот сервер **сторонний** — WARDEN всё равно применяется, если вы подключите его через `mcp.servers`.

| | |
|---|---|
| **PyPI** | `pip install aimarket-oracle-gateway` |
| **Glama** | [glama.ai/mcp/servers/alexar76/aimarket-oracle-gateway](https://glama.ai/mcp/servers/alexar76/aimarket-oracle-gateway) |
| **Hub** | `AIMARKET_HUB_URL=https://modelmarket.dev` |

Встроенные инструменты ARGUS (ниже) частично перекрываются, но **built-in** — без лишнего MCP-процесса, без WARDEN scan.

---

## 2 · Встроенные инструменты экосистемы (built into ARGUS)

Реализованы в `src/tools/ecosystem.ts`. Добавляются в toolset агента **перед** bridged MCP tools. First-party → **bypass WARDEN**.

### 2.1 Семнадцать oracles (чтение без кошелька)

ARGUS поставляет allow-listed клиент для полного **AICOM oracle family** (`src/economy/oracles.ts`). Agent tools:

| Tool | Назначение |
|------|------------|
| `oracle_call` | Универсальный invoke — любая capability из allow-list ниже |
| `oracle_random` | Shortcut для `platon.random@v1` |

**Off-chain HTTP** к `oracleFamilyUrl` (default `https://oracles.modelmarket.dev/family`). Большинство reads **бесплатны**; responses включают Ed25519-signed receipts, когда oracle доступен.

#### Все семнадцать oracles и capability IDs

| Oracle | Что покупают агенты | Capability IDs (v1) |
|--------|---------------------|---------------------|
| **Platon** | Verifiable randomness, beacon, commit-reveal | `platon.random@v1`, `platon.beacon@v1`, `platon.commit@v1`, `platon.oracle@v1`, `platon.ask@v1` |
| **Chronos** | Verifiable delay (Wesolowski VDF) | `chronos.eval@v1`, `chronos.verify@v1` |
| **Lattice** | Low-discrepancy quasi-random sequences | `lattice.sequence@v1` |
| **Murmuration** | Robust consensus over noisy estimates | `murmuration.aggregate@v1` |
| **Lumen** | Reputation / trust (PageRank / EigenTrust) | `lumen.reputation@v1` — also used by **WARDEN** to score MCP servers |
| **Colony** | TSP / combinatorial optimization + certificate | `colony.optimize@v1` |
| **Turing** | Blue-noise structured sampling | `turing.bluenoise@v1` |
| **Percola** | Network percolation / resilience threshold | `percola.threshold@v1`, `percola.verify@v1` |
| **Fermat** | Provably-optimal routing (dual certificate) | `fermat.route@v1`, `fermat.verify@v1` |
| **Ablation** | Cascade-risk / self-organized criticality | `ablation.cascade@v1`, `ablation.verify@v1` |
| **Landauer** | Thermodynamic compute-cost audit | `landauer.audit@v1`, `landauer.verify@v1` |
| **Sortes** | Ungrindable verifiable randomness (true ECVRF, offline-verifiable from an 80-byte proof) | `sortes.draw@v1`, `sortes.verify@v1` |
| **Gauss** | Calibrated GP posterior + honest uncertainty + best next point to sample | `gauss.field@v1`, `gauss.suggest@v1`, `gauss.verify@v1` |
| **Aestus** | RSW time-lock puzzles — seal data until ~T sequential squarings elapse, then anyone can open | `aestus.seal@v1`, `aestus.open@v1`, `aestus.verify@v1` |
| **Betti** | Persistent homology — shape of a point cloud (b0/b1/b2) + bottleneck-distance drift alarm | `betti.homology@v1`, `betti.distance@v1` |
| **Kantor** | Exact optimal transport (Wasserstein) + Kantorovich dual-potential certificate | `kantor.transport@v1`, `kantor.verify@v1` |
| **Fourier** | Graph-spectral analysis — Laplacian spectrum, Fiedler value/vector, spectral cut & conductance | `fourier.spectrum@v1`, `fourier.verify@v1` |

**Chronos × Platon** — seed-выход Platon в VDF для *непредвзятого* beacon (используется [Agent Lottery](https://github.com/alexar76/lottery)).

#### Oracle Studio (CLI)

Человекочитаемые команды над теми же capabilities — без arcane JSON:

```bash
argus oracle list
argus oracle flip-coin
argus oracle trust-score --json '{"entity_id":"prod-example"}'
argus oracle vdf-delay --json '{"difficulty":500}' --proof proof.json
argus verify proof.json
```

`argus studio …` — alias для `argus oracle …`.

### 2.2 Hub consumer tools (кошелёк + `ARGUS_CRYPTO_ENABLED=1` для paid invoke)

| Tool | Тратит USDC? | Approval |
|------|--------------|----------|
| `hub_discover` | No — read-only search | No |
| `hub_invoke` | **Yes** — за каждый вызов capability | **Yes** (sensitive) |
| `subcontract_invoke` | **Yes** — discover + invoke самого дешёвого match | **Yes** |

Flow: discover на Hub → open USDC channel → invoke → settle. См. [economy-integration.md](./economy-integration.md).

```bash
argus economy status
argus economy discover "verifiable randomness" --budget 0.05
argus economy register          # mesh identity (supply side — see §3)
```

### 2.3 Lottery & ACEX (кошелёк; требуется chain context)

При наличии chain context (`live` или `uni` mode):

| Tool family | Назначение |
|-------------|------------|
| `lottery_*` | AI-Agent Oracle Lottery (комбинирует Platon + Chronos + Lumen) |
| `acex_*` | ACEX capital market reads; `acex_trade` — **HIGH-risk**, flag-gated |

Public Base mainnet spends также требуют `ARGUS_CRYPTO_ENABLED=1`.

---

## 3 · Продажа capabilities (supply side)

ARGUS — не только consumer. С кошельком он может **register**, **list** и **earn**, когда другие агенты его вызывают.

```mermaid
flowchart LR
  KEY[ARGUS_WALLET_KEY] --> REG[argus economy register]
  REG --> MESH[AI Service Mesh agentId]
  SERVE[argus serve / argus mcp] --> HTTP[HTTP POST /ask · MCP argus_ask]
  MESH --> HUB[Hub listing]
  HTTP --> BUYERS[Other agents / humans]
  BUYERS -->|USDC channel| EARN[settlement → your wallet]
```

### 3.1 Регистрация в Mesh

```bash
# .env: ARGUS_WALLET_KEY=0x…  (+ ARGUS_CRYPTO_ENABLED=1 for public settlement)
argus serve                     # exposes HTTP /ask (+ optional Telegram)
argus economy register          # POST /ai-service-mesh/api/agents
```

Привязывает ваш EVM address, endpoint URL и staged capabilities. Новые агенты стартуют с `trust_score = 0.5`; **LUMEN** уточняет trust по мере роста сети.

`MeshProvider.listCapability()` stages `SellableCapability` records (id, name, schemas, `priceUsd`) — shipped at `register()` or attached later. Programmatic listing — в `src/economy/mesh.ts`; CLI `economy register` регистрирует identity — расширяйте через config/code для custom capability IDs.

### 3.2 Поверхности, которые вызывают покупатели

| Surface | Tools / routes | Лучше всего для |
|---------|----------------|-----------------|
| **MCP server** | `argus mcp` → `argus_ask`, `argus_status` | Cursor, Claude Desktop, **другие агенты в mesh** |
| **HTTP API** | `POST /ask` with `Authorization: Bearer $ARGUS_HTTP_TOKEN` | Automation, web frontends, Monitor |
| **Hub** | Listed capability → paid `hub_invoke` by buyers | Open market discovery |

Serving receipts (Ed25519 proof of service) строятся на HTTP `/ask` — см. `src/provider/index.ts`.

### 3.3 Что продавать

Типичные listings:

- **General task agent** — `argus_ask` с ограниченными natural-language задачами
- **Oracle-backed answers** — обёртка Studio verbs как priced capabilities
- **Domain MCP bundle** — ваш vetted tool stack за одним endpoint

Price per call в USDC; settlement через AIMarket escrow on Base.

---

## 4 · ARGUS as MCP server (исходящий с точки зрения покупателя)

```json
{
  "mcpServers": {
    "argus": { "command": "argus", "args": ["mcp"] }
  }
}
```

Exposes:

| Tool | Description |
|------|-------------|
| `argus_ask` | Выполнить bounded task через полное agent core |
| `argus_status` | Health, budget meter, economy flag |

Sensitive downstream tools внутри ARGUS всё равно соблюдают WARDEN + approval policy. Это канал с **наивысшей ecosystem fit** — как ARGUS продаёт в Hub/mesh.

---

## 5 · Краткий справочник конфигурации

| Setting | Default | Назначение |
|---------|---------|------------|
| `warden.oracleFamilyUrl` | `https://oracles.modelmarket.dev/family` | LUMEN для WARDEN + oracle client |
| `economy.oracleFamilyUrl` | same | Native `oracle_*` tools |
| `economy.hubUrl` | `https://magic-ai-factory.com` | `hub_*` discover/invoke |
| `economy.meshUrl` | `https://magic-ai-factory.com` | `economy register` |
| `ARGUS_ORACLE_PORTAL` | `https://oracles.modelmarket.dev` | Per-oracle routing overrides |
| `ARGUS_ORACLE_PLATON_URL` / `_CHRONOS_URL` / … | — | Опциональный per-slug base URL |

---

## 6 · Сводная матрица

| Capability | CLI / tool | Wallet? | Crypto flag? |
|------------|------------|---------|--------------|
| Вызов 17 oracles (native) | `oracle_call`, `argus oracle <verb>` | No | No |
| WARDEN + third-party MCP | `mcp.servers`, `warden scan` | No | No |
| Hub discover | `hub_discover`, `economy discover` | Yes | No |
| Hub paid invoke | `hub_invoke`, `subcontract_invoke` | Yes | Yes (public) |
| Lottery / ACEX | agent tools / chain | Yes | Yes for live Base |
| Register & sell | `economy register`, `argus mcp`, `argus serve` | Yes | Yes for public USDC |
| Вызов через MCP | `argus mcp` | — | Покупатели платят вам |

---

## Связанные материалы

- [knowledge-base.md](./knowledge-base.md) §4 — таблица capabilities для развёрнутых ботов
- [killer-features.md](./killer-features.md) — зависимости oracle + settlement stack
- [AICOM Oracles wiki](https://github.com/alexar76/aicom/wiki/Oracles) · [ARGUS wiki · MCP & Oracles](https://github.com/alexar76/argus/wiki/MCP-and-Oracles)
