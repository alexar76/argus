# Артефакты публичного MCP-бенчмарка WARDEN

> 🌐 Язык: [English](./README.md) · **Русский** · [Español](./README-es.md)

Переиспользуемые входы/выходы для публичного MCP-сканирования, описанного в:

| Язык | Отчёт |
|:-----|:-------|
| EN | [../warden-scan-report.md](../warden-scan-report.md) |
| RU | [../warden-scan-report-ru.md](../warden-scan-report-ru.md) |
| ES | [../warden-scan-report-es.md](../warden-scan-report-es.md) |

| Файл | Роль |
|:-----|:-----|
| `argus.config.json` | Конфиг сканирования (`blockAtSeverity: high`, …) |
| `scan-output.txt` | Сырой лог CLI (английский machine output — не локализуется) |

```bash
cd argus
npm run build
node dist/index.js warden scan --config docs/warden-scan/argus.config.json
```
