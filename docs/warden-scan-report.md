# WARDEN — scan of 10 public MCP servers

> 🌐 Language: **English** · [Русский](./warden-scan-report-ru.md) · [Español](./warden-scan-report-es.md)

**Date:** 2026-07-16  
**Tool:** `argus warden scan` (ARGUS v0.2.0)  
**Policy:** `blockAtSeverity: high`, `minReputation: 0.25`, `allowUnknownServers: true`  
**Config:** [`warden-scan/argus.config.json`](./warden-scan/argus.config.json)  
**Raw log:** [`warden-scan/scan-output.txt`](./warden-scan/scan-output.txt)

---

## Summary

| Metric | Value |
|:-------|:------|
| Servers in run | **10** |
| ✅ Allowed (ALLOW) | **8** |
| 🛑 Blocked (BLOCKED) | **1** |
| ⚠️ Unreachable (UNREACHABLE) | **1** |
| Tools after filter | **76** (of 78 declared on live servers) |
| Critical findings (high) | **2** (both — Context7 MCP) |

---

## Results per server

| # | Server | Package / launch | Verdict | Score | Tools | Top findings |
|:-:|:-------|:-----------------|:--------|------:|:-----:|:-------------|
| 1 | **MCP Filesystem** | `npx -y @modelcontextprotocol/server-filesystem /tmp` | ✅ ALLOW | 0.54 | 14/14 | — |
| 2 | **MCP Memory** | `npx -y @modelcontextprotocol/server-memory` | ✅ ALLOW | 0.54 | 9/9 | — |
| 3 | **MCP Everything** *(reference)* | `npx -y @modelcontextprotocol/server-everything` | ✅ ALLOW | 0.38 | 13/13 | 🟡 `get-env` — secret request in tool description |
| 4 | **MCP Sequential Thinking** | `npx -y @modelcontextprotocol/server-sequential-thinking` | ✅ ALLOW | 0.54 | 1/1 | — |
| 5 | **MCP Git** | `uvx mcp-server-git` | ✅ ALLOW | 0.54 | 12/12 | — |
| 6 | **MCP Fetch** | `uvx mcp-server-fetch` | ✅ ALLOW | 0.54 | 1/1 | — |
| 7 | **MCP Time** | `uvx mcp-server-time` | ✅ ALLOW | 0.54 | 2/2 | — |
| 8 | **Playwright MCP** | `npx -y @playwright/mcp@latest` | ✅ ALLOW | 0.49 | 24/24 | 🟢 3× low injection in schema (`browser_*`) |
| 9 | **Context7 MCP** | `npx -y @upstash/context7-mcp@latest` | 🛑 **BLOCKED** | 0.22 | 0/2 | 🔴 2× high `TOOL_DEF_SECRET_REQUEST`; 2× medium injection |
| 10 | **Brave Search MCP** | `npx -y @modelcontextprotocol/server-brave-search` | ⚠️ UNREACHABLE | — | — | No `BRAVE_API_KEY` (process did not start; WARDEN did not score it) |

**Legend:** ✅ allow · 🛑 blocked by WARDEN · ⚠️ process never came up · 🔴 high · 🟡 medium · 🟢 low

---

## Finding details

### 🛑 Context7 MCP — blocked (`static-scan`, score 0.22)

The server started, but WARDEN **allowed zero tools**:

| Severity | Code | Tool | What |
|:---------|:-----|:-----|:-----|
| **high** | `TOOL_DEF_SECRET_REQUEST` | `resolve-library-id` | Input schema matches credentials / access-token patterns |
| **high** | `TOOL_DEF_SECRET_REQUEST` | `query-docs` | Same |
| medium | `TOOL_DEF_INJECTION` | `resolve-library-id` | “you must” in description |
| medium | `TOOL_DEF_INJECTION` | `query-docs` | “you must” in description |
| low | `TOOL_DEF_INJECTION` | both | “instead of” in schema |

**Takeaway:** a docs MCP with aggressive tool-defs — classic deny-by-default candidate.

### ✅ MCP Everything (reference) — allow with warning

| Severity | Code | Tool | What |
|:---------|:-----|:-----|:-----|
| medium | `TOOL_DEF_SECRET_REQUEST` | `get-env` | Tool description explicitly about `.env` / environment variables |

Reference server for MCP tests; do not wire into production without a sandbox.

### ✅ Playwright MCP — allow, low risk

Three **low** `TOOL_DEF_INJECTION` hits on `browser_take_screenshot`, `browser_snapshot`, `browser_click` — phrase match on “instead of” in JSON schema; does not block at `blockAtSeverity: high`.

### ⚠️ Brave Search MCP — unreachable

Package is deprecated on npm; process exits without `BRAVE_API_KEY`. This is an **infrastructure** failure, not a WARDEN verdict.

---

## How to reproduce

```bash
cd argus
npm run build
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```

For Brave Search (optional):

```bash
export BRAVE_API_KEY=your_key
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```

---

## Conclusions

1. **Official reference servers** (Filesystem, Memory, Git, Fetch, Time, Sequential Thinking) clear WARDEN at score **0.54** with no high findings.
2. **Everything** is the only green allow with a medium (test `get-env`); score is lower (**0.38**) due to the secret-request penalty.
3. **Context7** is the only **BLOCKED** result: high-severity secret-request in tool definitions → correct deny-by-default behavior.
4. **Playwright MCP** has a large surface (24 tools) but only low noise in the static scan.
5. **Brave Search** was not scored; needs an API key, and the package is deprecated.

---

*Scan ran locally via `npx` / `uvx`; each server is a separate stdio process, vetted before `listTools()`.*
