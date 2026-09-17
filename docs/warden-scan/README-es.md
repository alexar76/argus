# Artefactos del benchmark MCP público de WARDEN

> 🌐 Idiomas: [English](./README.md) · [Русский](./README-ru.md) · **Español**

Entradas/salidas reutilizables para el escaneo MCP público documentado en:

| Idioma | Informe |
|:-------|:--------|
| EN | [../warden-scan-report.md](../warden-scan-report.md) |
| RU | [../warden-scan-report-ru.md](../warden-scan-report-ru.md) |
| ES | [../warden-scan-report-es.md](../warden-scan-report-es.md) |

| Archivo | Rol |
|:--------|:----|
| `argus.config.json` | Config del escaneo (`blockAtSeverity: high`, …) |
| `scan-output.txt` | Log CLI en bruto (salida de máquina en inglés — no localizada) |

```bash
cd argus
npm run build
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```
