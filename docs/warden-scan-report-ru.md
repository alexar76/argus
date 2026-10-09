# WARDEN — скан 10 публичных MCP-серверов

> 🌐 Язык: [English](./warden-scan-report.md) · **Русский** · [Español](./warden-scan-report-es.md)

**Дата:** 2026-07-16  
**Инструмент:** `argus warden scan` (ARGUS v0.2.0)  
**Политика:** `blockAtSeverity: high`, `minReputation: 0.25`, `allowUnknownServers: true`  
**Конфиг:** [`warden-scan/argus.config.json`](./warden-scan/argus.config.json)  
**Сырой лог:** [`warden-scan/scan-output.txt`](./warden-scan/scan-output.txt)

---

## Сводка

| Метрика | Значение |
|:--------|:---------|
| Серверов в прогоне | **10** |
| ✅ Разрешено (ALLOW) | **8** |
| 🛑 Заблокировано (BLOCKED) | **1** |
| ⚠️ Недоступен (UNREACHABLE) | **1** |
| Инструментов после фильтра | **76** (из 78 объявленных на живых серверах) |
| Критичных находок (high) | **2** (оба — Context7 MCP) |

---

## Результаты по каждому серверу

| # | Сервер | Пакет / запуск | Вердикт | Score | Tools | Главные находки |
|:-:|:-------|:---------------|:--------|------:|:-----:|:----------------|
| 1 | **MCP Filesystem** | `npx -y @modelcontextprotocol/server-filesystem /tmp` | ✅ ALLOW | 0.54 | 14/14 | — |
| 2 | **MCP Memory** | `npx -y @modelcontextprotocol/server-memory` | ✅ ALLOW | 0.54 | 9/9 | — |
| 3 | **MCP Everything** *(reference)* | `npx -y @modelcontextprotocol/server-everything` | ✅ ALLOW | 0.38 | 13/13 | 🟡 `get-env` — запрос секретов в описании tool |
| 4 | **MCP Sequential Thinking** | `npx -y @modelcontextprotocol/server-sequential-thinking` | ✅ ALLOW | 0.54 | 1/1 | — |
| 5 | **MCP Git** | `uvx mcp-server-git` | ✅ ALLOW | 0.54 | 12/12 | — |
| 6 | **MCP Fetch** | `uvx mcp-server-fetch` | ✅ ALLOW | 0.54 | 1/1 | — |
| 7 | **MCP Time** | `uvx mcp-server-time` | ✅ ALLOW | 0.54 | 2/2 | — |
| 8 | **Playwright MCP** | `npx -y @playwright/mcp@latest` | ✅ ALLOW | 0.49 | 24/24 | 🟢 3× low injection в schema (`browser_*`) |
| 9 | **Context7 MCP** | `npx -y @upstash/context7-mcp@latest` | 🛑 **BLOCKED** | 0.22 | 0/2 | 🔴 2× high `TOOL_DEF_SECRET_REQUEST`; 2× medium injection |
| 10 | **Brave Search MCP** | `npx -y @modelcontextprotocol/server-brave-search` | ⚠️ UNREACHABLE | — | — | Нет `BRAVE_API_KEY` (сервер не стартовал; WARDEN не оценивал) |

**Легенда:** ✅ allow · 🛑 blocked by WARDEN · ⚠️ процесс не поднялся · 🔴 high · 🟡 medium · 🟢 low

---

## Детали находок

### 🛑 Context7 MCP — заблокирован (`static-scan`, score 0.22)

Сервер поднялся, но WARDEN **не пустил** ни один tool:

| Severity | Code | Tool | Суть |
|:---------|:-----|:-----|:-----|
| **high** | `TOOL_DEF_SECRET_REQUEST` | `resolve-library-id` | В input schema — паттерны credentials / access token |
| **high** | `TOOL_DEF_SECRET_REQUEST` | `query-docs` | То же |
| medium | `TOOL_DEF_INJECTION` | `resolve-library-id` | «you must» в description |
| medium | `TOOL_DEF_INJECTION` | `query-docs` | «you must» в description |
| low | `TOOL_DEF_INJECTION` | оба | «instead of» в schema |

**Вывод:** документационный MCP с агрессивными tool-def — типичный кандидат на deny-by-default.

### ✅ MCP Everything (reference) — allow с предупреждением

| Severity | Code | Tool | Суть |
|:---------|:-----|:-----|:-----|
| medium | `TOOL_DEF_SECRET_REQUEST` | `get-env` | Описание tool явно про `.env` / environment variables |

Reference-сервер для тестов MCP; в проде не подключать без sandbox.

### ✅ Playwright MCP — allow, низкий риск

Три **low** срабатывания `TOOL_DEF_INJECTION` на `browser_take_screenshot`, `browser_snapshot`, `browser_click` — совпадение фразы «instead of» в JSON schema, не блокирует при `blockAtSeverity: high`.

### ⚠️ Brave Search MCP — unreachable

Пакет deprecated на npm; процесс падает без `BRAVE_API_KEY`. Это **инфраструктурная** ошибка, не вердикт WARDEN.

---

## Как повторить

```bash
cd argus
npm run build
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```

Для Brave Search (опционально):

```bash
export BRAVE_API_KEY=your_key
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```

---

## Выводы

1. **Официальные reference-серверы** (Filesystem, Memory, Git, Fetch, Time, Sequential Thinking) проходят WARDEN с score **0.54** и без high-находок.
2. **Everything** — единственный «зелёный» allow с medium (тестовый `get-env`); score ниже (**0.38**) из-за штрафа за secret-request.
3. **Context7** — единственный **BLOCKED**: high-severity secret-request в tool definitions → правильное поведение deny-by-default.
4. **Playwright MCP** — большой surface (24 tools), но только low noise в static scan.
5. **Brave Search** — не оценён; нужен API key + пакет deprecated.

---

*Скан выполнен локально через `npx` / `uvx`; каждый сервер — отдельный stdio-процесс, vetting до `listTools()`.*
