# WARDEN public MCP benchmark artifacts

> 🌐 Language: **English** · [Русский](./README-ru.md) · [Español](./README-es.md)

Reusable inputs/outputs for the public MCP scan documented in:

| Lang | Report |
|:-----|:-------|
| EN | [../warden-scan-report.md](../warden-scan-report.md) |
| RU | [../warden-scan-report-ru.md](../warden-scan-report-ru.md) |
| ES | [../warden-scan-report-es.md](../warden-scan-report-es.md) |

| File | Role |
|:-----|:-----|
| `argus.config.json` | Scan config (`blockAtSeverity: high`, …) |
| `scan-output.txt` | Raw CLI log (English machine output — not localized) |

```bash
cd argus
npm run build
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```
