# WARDEN — escaneo de 10 servidores MCP públicos

> 🌐 Idiomas: [English](./warden-scan-report.md) · [Русский](./warden-scan-report-ru.md) · **Español**

**Fecha:** 2026-07-16  
**Herramienta:** `argus warden scan` (ARGUS v0.2.0)  
**Política:** `blockAtSeverity: high`, `minReputation: 0.25`, `allowUnknownServers: true`  
**Config:** [`warden-scan/argus.config.json`](./warden-scan/argus.config.json)  
**Log en bruto:** [`warden-scan/scan-output.txt`](./warden-scan/scan-output.txt)

---

## Resumen

| Métrica | Valor |
|:--------|:------|
| Servidores en la corrida | **10** |
| ✅ Permitidos (ALLOW) | **8** |
| 🛑 Bloqueados (BLOCKED) | **1** |
| ⚠️ Inalcanzables (UNREACHABLE) | **1** |
| Herramientas tras el filtro | **76** (de 78 declaradas en servidores vivos) |
| Hallazgos críticos (high) | **2** (ambos — Context7 MCP) |

---

## Resultados por servidor

| # | Servidor | Paquete / arranque | Veredicto | Score | Tools | Hallazgos principales |
|:-:|:---------|:-------------------|:----------|------:|:-----:|:----------------------|
| 1 | **MCP Filesystem** | `npx -y @modelcontextprotocol/server-filesystem /tmp` | ✅ ALLOW | 0.54 | 14/14 | — |
| 2 | **MCP Memory** | `npx -y @modelcontextprotocol/server-memory` | ✅ ALLOW | 0.54 | 9/9 | — |
| 3 | **MCP Everything** *(reference)* | `npx -y @modelcontextprotocol/server-everything` | ✅ ALLOW | 0.38 | 13/13 | 🟡 `get-env` — petición de secretos en la descripción del tool |
| 4 | **MCP Sequential Thinking** | `npx -y @modelcontextprotocol/server-sequential-thinking` | ✅ ALLOW | 0.54 | 1/1 | — |
| 5 | **MCP Git** | `uvx mcp-server-git` | ✅ ALLOW | 0.54 | 12/12 | — |
| 6 | **MCP Fetch** | `uvx mcp-server-fetch` | ✅ ALLOW | 0.54 | 1/1 | — |
| 7 | **MCP Time** | `uvx mcp-server-time` | ✅ ALLOW | 0.54 | 2/2 | — |
| 8 | **Playwright MCP** | `npx -y @playwright/mcp@latest` | ✅ ALLOW | 0.49 | 24/24 | 🟢 3× low injection en schema (`browser_*`) |
| 9 | **Context7 MCP** | `npx -y @upstash/context7-mcp@latest` | 🛑 **BLOCKED** | 0.22 | 0/2 | 🔴 2× high `TOOL_DEF_SECRET_REQUEST`; 2× medium injection |
| 10 | **Brave Search MCP** | `npx -y @modelcontextprotocol/server-brave-search` | ⚠️ UNREACHABLE | — | — | Sin `BRAVE_API_KEY` (el proceso no arrancó; WARDEN no lo evaluó) |

**Leyenda:** ✅ allow · 🛑 blocked by WARDEN · ⚠️ el proceso no arrancó · 🔴 high · 🟡 medium · 🟢 low

---

## Detalle de hallazgos

### 🛑 Context7 MCP — bloqueado (`static-scan`, score 0.22)

El servidor arrancó, pero WARDEN **no permitió ninguna** tool:

| Severity | Code | Tool | Qué |
|:---------|:-----|:-----|:----|
| **high** | `TOOL_DEF_SECRET_REQUEST` | `resolve-library-id` | El input schema coincide con patrones de credentials / access token |
| **high** | `TOOL_DEF_SECRET_REQUEST` | `query-docs` | Igual |
| medium | `TOOL_DEF_INJECTION` | `resolve-library-id` | «you must» en description |
| medium | `TOOL_DEF_INJECTION` | `query-docs` | «you must» en description |
| low | `TOOL_DEF_INJECTION` | ambos | «instead of» en schema |

**Conclusión:** un MCP de documentación con tool-defs agresivos — candidato clásico a deny-by-default.

### ✅ MCP Everything (reference) — allow con aviso

| Severity | Code | Tool | Qué |
|:---------|:-----|:-----|:----|
| medium | `TOOL_DEF_SECRET_REQUEST` | `get-env` | La descripción del tool habla explícitamente de `.env` / environment variables |

Servidor de referencia para tests MCP; no conectarlo en producción sin sandbox.

### ✅ Playwright MCP — allow, riesgo bajo

Tres aciertos **low** de `TOOL_DEF_INJECTION` en `browser_take_screenshot`, `browser_snapshot`, `browser_click` — coincidencia de la frase «instead of» en el JSON schema; no bloquea con `blockAtSeverity: high`.

### ⚠️ Brave Search MCP — unreachable

El paquete está deprecated en npm; el proceso falla sin `BRAVE_API_KEY`. Es un fallo de **infraestructura**, no un veredicto de WARDEN.

---

## Cómo reproducir

```bash
cd argus
npm run build
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```

Para Brave Search (opcional):

```bash
export BRAVE_API_KEY=your_key
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```

---

## Conclusiones

1. Los **servidores de referencia oficiales** (Filesystem, Memory, Git, Fetch, Time, Sequential Thinking) pasan WARDEN con score **0.54** y sin hallazgos high.
2. **Everything** es el único allow «verde» con medium (test `get-env`); el score baja (**0.38**) por la penalización de secret-request.
3. **Context7** es el único **BLOCKED**: secret-request de severidad high en tool definitions → comportamiento correcto deny-by-default.
4. **Playwright MCP** tiene mucha superficie (24 tools), pero solo ruido low en el static scan.
5. **Brave Search** no se evaluó; hace falta API key y el paquete está deprecated.

---

*Escaneo ejecutado en local con `npx` / `uvx`; cada servidor es un proceso stdio aparte, vetting antes de `listTools()`.*
